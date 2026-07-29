from __future__ import annotations

import random
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

WORKER_DIRECTORY = Path(__file__).resolve().parents[1] / "python"
sys.path.insert(0, str(WORKER_DIRECTORY))

import qwen_batch_worker as worker  # noqa: E402


class FakeAccelerator:
    def __init__(self, *, built: bool = True, available: bool = True) -> None:
        self.built = built
        self.available = available
        self.calls: list[tuple[str, int | None]] = []

    def is_built(self) -> bool:
        return self.built

    def is_available(self) -> bool:
        return self.available

    def manual_seed(self, seed: int) -> None:
        self.calls.append(("manual_seed", seed))

    def manual_seed_all(self, seed: int) -> None:
        self.calls.append(("manual_seed_all", seed))

    def synchronize(self) -> None:
        self.calls.append(("synchronize", None))

    def empty_cache(self) -> None:
        self.calls.append(("empty_cache", None))


class FakeBackends:
    def __init__(self, mps: FakeAccelerator) -> None:
        self.mps = mps


class FakeTorch:
    float32 = object()
    bfloat16 = object()

    def __init__(self, *, mps_available: bool = True, cuda_available: bool = True) -> None:
        self.mps = FakeAccelerator(available=mps_available)
        self.cuda = FakeAccelerator(available=cuda_available)
        self.backends = FakeBackends(self.mps)
        self.manual_seed_calls: list[int] = []

    def manual_seed(self, seed: int) -> None:
        self.manual_seed_calls.append(seed)


class FakeNumpyRandom:
    def __init__(self) -> None:
        self.calls: list[int] = []

    def seed(self, seed: int) -> None:
        self.calls.append(seed)


class FakeNumpy:
    def __init__(self) -> None:
        self.random = FakeNumpyRandom()


class QwenTorchBackendTest(unittest.TestCase):
    def test_selects_exact_proven_mps_float32_sdpa_path(self) -> None:
        torch = FakeTorch()

        backend = worker.select_torch_backend(torch, platform_name="darwin")

        self.assertEqual(backend.name, "mps")
        self.assertEqual(backend.parameter_device_type, "mps")
        self.assertEqual(
            backend.model_load_kwargs(torch),
            {
                "device_map": "mps",
                "dtype": torch.float32,
                "attn_implementation": "sdpa",
                "local_files_only": True,
                "use_safetensors": True,
            },
        )

    def test_mps_rejects_device_or_float32_residency_drift(self) -> None:
        torch = FakeTorch()
        backend = worker.select_torch_backend(torch, platform_name="darwin")

        class Model:
            def __init__(self, device_type: str, dtype: object) -> None:
                self.parameter = type(
                    "Parameter",
                    (),
                    {"device": type("Device", (), {"type": device_type})(), "dtype": dtype},
                )()

            def parameters(self):
                yield self.parameter

        backend.assert_model_residency(torch, Model("mps", torch.float32))
        with self.assertRaisesRegex(ValueError, "mps/float32"):
            backend.assert_model_residency(torch, Model("cpu", torch.float32))
        with self.assertRaisesRegex(ValueError, "mps/float32"):
            backend.assert_model_residency(torch, Model("mps", torch.bfloat16))

    def test_mps_seed_sync_and_cleanup_are_deterministic_and_backend_specific(self) -> None:
        torch = FakeTorch()
        numpy = FakeNumpy()
        backend = worker.select_torch_backend(torch, platform_name="darwin")

        with patch.object(random, "seed") as random_seed:
            backend.set_seed(torch, numpy, 2072318748)
        backend.synchronize(torch)
        backend.empty_cache(torch)
        backend.synchronize(torch)

        random_seed.assert_called_once_with(2072318748)
        self.assertEqual(numpy.random.calls, [2072318748])
        self.assertEqual(torch.manual_seed_calls, [2072318748])
        self.assertEqual(
            torch.mps.calls,
            [
                ("manual_seed", 2072318748),
                ("synchronize", None),
                ("empty_cache", None),
                ("synchronize", None),
            ],
        )
        self.assertEqual(torch.cuda.calls, [])

    def test_linux_retains_cuda_bfloat16_seed_sync_and_cleanup(self) -> None:
        torch = FakeTorch()
        numpy = FakeNumpy()
        backend = worker.select_torch_backend(torch, platform_name="linux")

        backend.set_seed(torch, numpy, 8101)
        backend.synchronize(torch)
        backend.empty_cache(torch)

        self.assertEqual(backend.name, "cuda")
        self.assertEqual(backend.parameter_device_type, "cuda")
        self.assertEqual(backend.model_load_kwargs(torch)["device_map"], "cuda:0")
        self.assertIs(backend.model_load_kwargs(torch)["dtype"], torch.bfloat16)
        self.assertEqual(torch.manual_seed_calls, [8101])
        self.assertEqual(torch.cuda.calls, [("manual_seed_all", 8101), ("synchronize", None), ("empty_cache", None)])
        self.assertEqual(torch.mps.calls, [])

    def test_mps_mvp_policy_rejects_conditional_and_excluded_profiles(self) -> None:
        self.assertNotIn("eric-neutral-read", worker.SELECTED_PROFILE_IDS)
        self.assertNotIn("serena-neutral-read", worker.SELECTED_PROFILE_IDS)
        self.assertIn("dylan-neutral-read", worker.SELECTED_PROFILE_IDS)

        def segment(profile_id: str) -> dict[str, object]:
            return {
                "sequence": 1,
                "segmentId": "ch1-1",
                "text": "A synthetic test line.",
                "voiceProfileId": profile_id,
                "seed": 1,
                "renderIdentitySha256": "a" * 64,
                "applicationInputIdentity": None,
                "delivery": {
                    "emotion": "neutral",
                    "pace": "normal",
                    "volume": "normal",
                    "pauseAfterMs": 0,
                },
                "effectiveInstruction": "test",
                "fallbackApproval": None,
            }

        worker.validate_segment(segment("dylan-neutral-read"), set(), 0)
        for profile_id in ("eric-neutral-read", "serena-neutral-read"):
            with self.assertRaisesRegex(ValueError, "voice profile is not selected"):
                worker.validate_segment(segment(profile_id), set(), 0)

    def test_never_falls_back_to_an_unapproved_device(self) -> None:
        with self.assertRaisesRegex(ValueError, "MPS backend is unavailable"):
            worker.select_torch_backend(FakeTorch(mps_available=False), platform_name="darwin")
        with self.assertRaisesRegex(ValueError, "CUDA is unavailable"):
            worker.select_torch_backend(FakeTorch(cuda_available=False), platform_name="linux")
        with self.assertRaisesRegex(ValueError, "unsupported platform"):
            worker.select_torch_backend(FakeTorch(), platform_name="win32")


if __name__ == "__main__":
    unittest.main()
