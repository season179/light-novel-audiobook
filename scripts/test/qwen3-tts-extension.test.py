from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import math
import struct
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
CORE_PATH = ROOT / "scripts/qwen3-tts/core.py"
SPEC = importlib.util.spec_from_file_location("qwen_core", CORE_PATH)
assert SPEC and SPEC.loader
CORE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CORE)
LOCK_PATH = ROOT / "config/qwen3-tts-custom-voice.lock.json"


def sine_wav(frequency: float = 180, seconds: float = 1, sample_rate: int = 24000, amplitude: int = 8000) -> bytes:
    frames = round(seconds * sample_rate)
    pcm = bytearray()
    for index in range(frames):
        sample = round(amplitude * math.sin(2 * math.pi * frequency * index / sample_rate))
        pcm.extend(struct.pack("<h", sample))
    with tempfile.TemporaryFile() as stream:
        with wave.open(stream, "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(sample_rate)
            output.writeframes(pcm)
        stream.seek(0)
        return stream.read()


def mock_analysis(hash_value: str, duration: float = 3.0) -> dict:
    return {
        "audio": {
            "container": "RIFF/WAVE",
            "encoding": "PCM",
            "channels": 1,
            "sampleRateHz": 24000,
            "bitsPerSample": 16,
            "frames": round(duration * 24000),
            "durationSeconds": duration,
            "bytes": round(duration * 48000) + 44,
            "sha256": hash_value,
        },
        "objective": {
            "peakDbfs": -3.0,
            "rmsDbfs": -18.0,
            "clippedSampleFraction": 0.0,
            "activeFrameFraction": 0.9,
        },
        "sourceFloat": {"peakAbsolute": 0.7, "outOfRangeSampleFraction": 0.0},
    }


def passing_fixture() -> tuple[dict, list[dict]]:
    lock = CORE.load_lock(LOCK_PATH)
    outputs = []
    for sequence, case in enumerate(CORE.expected_cases(lock), start=1):
        profile, voice, line, repetition = case["profile"], case["voice"], case["line"], case["repetition"]
        primary_key = f"{profile['id']}:{voice['id']}:{line['id']}"
        digest = hashlib.sha256(primary_key.encode()).hexdigest()
        suffix = "-repeat" if repetition else ""
        outputs.append(
            {
                "sequence": sequence,
                "profileId": profile["id"],
                "profileKind": profile["kind"],
                "parameters": copy.deepcopy(profile["parameters"]),
                "voiceId": voice["id"],
                "role": voice["role"],
                "speaker": voice["speaker"],
                "language": voice["language"],
                "instruction": voice["instruction"],
                "instructionSha256": voice["instructionSha256"],
                "lineId": line["id"],
                "text": line["text"],
                "textSha256": line["textSha256"],
                "seed": line["seed"],
                "seedMethod": "fixture",
                "repetition": repetition,
                "referenceAudioUsed": False,
                "nonStreamingMode": True,
                "apiSafety": {"greedyFlagsSupported": True},
                "file": f"outputs/{profile['id']}/{voice['id']}/{line['id']}{suffix}.wav",
                "elapsedSeconds": 1.0,
                "sha256": digest,
                "analysis": mock_analysis(digest),
            }
        )
    return lock, outputs


class QwenLockTests(unittest.TestCase):
    def test_lock_pins_exact_model_runtime_voices_and_lines(self) -> None:
        lock = CORE.load_lock(LOCK_PATH)
        self.assertEqual(lock["model"]["huggingFaceUsedStorageBytes"], 4_523_965_995)
        self.assertEqual(lock["model"]["revisionPayloadBytes"], 4_520_218_951)
        self.assertEqual(lock["model"]["revision"], "0c0e3051f131929182e2c023b9537f8b1c68adfe")
        self.assertEqual(len(lock["model"]["files"]), 13)
        weights = {item["path"]: item for item in lock["model"]["files"]}
        self.assertEqual(weights["model.safetensors"]["size"], 3_833_402_552)
        self.assertEqual(weights["model.safetensors"]["sha256"], "38b1d5971bdbd982b561cccec982669a53b0537c3cf5e9bd4778ed07bb2f5137")
        self.assertEqual(weights["speech_tokenizer/model.safetensors"]["size"], 682_293_092)
        self.assertEqual(lock["runtime"]["wheelSha256"], "11a290d8dabc7ef91a90c54478c8ab19b3edb1d85c0882313721892bdc4af15d")
        self.assertEqual(lock["runtime"]["sourceCommit"], "6cafe5582caea83df269c36b1ce62d953a9cc66b")
        self.assertEqual(lock["runtime"]["attentionImplementation"], "sdpa")
        self.assertFalse(lock["runtime"]["flashAttentionAllowed"])
        self.assertEqual([voice["speaker"] for voice in lock["voices"]], ["Aiden", "Ryan", "Serena"])
        self.assertEqual([line["seed"] for line in lock["lines"]], [8101, 8102, 8103])

    def test_lock_rejects_scope_hash_runtime_and_greedy_substitution(self) -> None:
        original = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
        mutations = [
            lambda value: value["scope"].update(modelId="Qwen/other"),
            lambda value: value["model"].update(revision="0" * 40),
            lambda value: value["model"]["files"][5].update(size=1),
            lambda value: value["runtime"].update(version="latest"),
            lambda value: value["runtime"].update(flashAttentionAllowed=True),
            lambda value: value["voices"][0].update(speaker="Other"),
            lambda value: value["lines"][0].update(text="changed"),
            lambda value: value["profiles"][1]["parameters"].update(doSample=True),
        ]
        for mutate in mutations:
            value = copy.deepcopy(original)
            mutate(value)
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "lock.json"
                path.write_text(json.dumps(value), encoding="utf-8")
                with self.assertRaises(ValueError):
                    CORE.load_lock(path)

    def test_uv_lock_is_complete_and_pins_runtime_wheel_without_flash_attention(self) -> None:
        uv_lock = (ROOT / "scripts/qwen3-tts-runtime/uv.lock").read_text(encoding="utf-8")
        self.assertIn('name = "qwen-tts"', uv_lock)
        self.assertIn('name = "torch"', uv_lock)
        self.assertIn('name = "torchaudio"', uv_lock)
        self.assertIn("11a290d8dabc7ef91a90c54478c8ab19b3edb1d85c0882313721892bdc4af15d", uv_lock)
        self.assertNotIn("flash-attn", uv_lock.lower())
        self.assertGreater(uv_lock.count("[[package]]"), 90)


class WavTests(unittest.TestCase):
    def test_strict_wav_analysis_measures_activity_and_clipping(self) -> None:
        analysis = CORE.analyze_pcm16_wav(sine_wav())
        self.assertEqual(analysis["audio"]["sampleRateHz"], 24000)
        self.assertEqual(analysis["audio"]["channels"], 1)
        self.assertEqual(analysis["audio"]["bitsPerSample"], 16)
        self.assertEqual(analysis["objective"]["activeFrameFraction"], 1.0)
        self.assertEqual(analysis["objective"]["clippedSampleFraction"], 0.0)

    def test_strict_wav_analysis_rejects_corruption_and_noncanonical_audio(self) -> None:
        valid = sine_wav()
        corruptions = [valid[:-2], valid + b"extra", b"NOPE" + valid[4:]]
        for data in corruptions:
            with self.assertRaises(ValueError):
                CORE.analyze_pcm16_wav(data)
        stereo = bytearray(valid)
        struct.pack_into("<H", stereo, 22, 2)
        with self.assertRaises(ValueError):
            CORE.analyze_pcm16_wav(bytes(stereo))


class ObjectiveReviewTests(unittest.TestCase):
    def test_exact_two_profile_matrices_and_repeats_pass(self) -> None:
        lock, outputs = passing_fixture()
        review = CORE.derive_objective_review(lock, outputs)
        self.assertTrue(all(review["checks"].values()))
        self.assertEqual(review["decision"]["result"], "GO for Qwen3-TTS technical evaluation")
        self.assertEqual(len(outputs), 24)
        self.assertTrue(review["repeatability"]["stockSeededAllByteIdentical"])
        self.assertTrue(review["repeatability"]["greedyAllByteIdentical"])
        self.assertIn("this run only", review["repeatability"]["scope"])

    def test_repeat_hash_mismatch_is_reported_without_false_repeatability_claim(self) -> None:
        lock, outputs = passing_fixture()
        repeated = next(item for item in outputs if item["profileId"] == "stock-seeded" and item["voiceId"] == "narrator" and item["repetition"] == 1)
        repeated["sha256"] = "f" * 64
        repeated["analysis"]["audio"]["sha256"] = repeated["sha256"]
        review = CORE.derive_objective_review(lock, outputs)
        self.assertTrue(all(review["checks"].values()))
        self.assertFalse(review["repeatability"]["stockSeededAllByteIdentical"])
        comparison = next(item for item in review["repeatability"]["comparisons"] if item["profileId"] == "stock-seeded" and item["voiceId"] == "narrator")
        self.assertEqual(comparison["claim"], "not byte-repeatable in this exact run")

    def test_adversarial_matrix_identity_api_and_audio_substitutions_fail(self) -> None:
        lock, fixture = passing_fixture()
        cases = [
            ("missing", "exactOutputMatrix", lambda values: values.pop()),
            ("extra", "exactOutputMatrix", lambda values: values.append(copy.deepcopy(values[0]))),
            ("duplicate key", "exactOutputMatrix", lambda values: values[1].update(lineId=values[0]["lineId"])),
            ("wrong profile", "exactOutputMatrix", lambda values: values[0].update(profileId="other")),
            ("sequence", "outputIdentity", lambda values: values[0].update(sequence=99)),
            ("text", "outputIdentity", lambda values: values[0].update(text="changed")),
            ("text hash", "outputIdentity", lambda values: values[0].update(textSha256="f" * 64)),
            ("speaker", "outputIdentity", lambda values: values[0].update(speaker="Other")),
            ("instruction", "outputIdentity", lambda values: values[0].update(instruction="Other")),
            ("seed", "outputIdentity", lambda values: values[0].update(seed=1)),
            ("parameter", "outputIdentity", lambda values: values[0]["parameters"].update(temperature=5)),
            ("reference audio", "noReferenceAudio", lambda values: values[0].update(referenceAudioUsed=True)),
            ("unsafe greedy", "greedyApiSupported", lambda values: next(item for item in values if item["profileId"] == "greedy")["apiSafety"].update(greedyFlagsSupported=False)),
            ("clipping", "strictWavAndAudioHealth", lambda values: values[0]["analysis"]["objective"].update(clippedSampleFraction=0.5)),
            ("silence", "strictWavAndAudioHealth", lambda values: values[0]["analysis"]["objective"].update(activeFrameFraction=0.0)),
            ("duration", "strictWavAndAudioHealth", lambda values: values[0]["analysis"]["audio"].update(durationSeconds=100.0)),
        ]
        for name, check, mutate in cases:
            values = copy.deepcopy(fixture)
            mutate(values)
            review = CORE.derive_objective_review(lock, values)
            self.assertFalse(review["checks"][check], name)
            self.assertTrue(review["decision"]["result"].startswith("NO-GO"), name)

    def test_manual_review_stays_pending_and_transcript_aligned(self) -> None:
        lock, outputs = passing_fixture()
        objective = CORE.derive_objective_review(lock, outputs)
        manual = CORE.create_manual_review(lock, outputs, objective)
        self.assertEqual(manual["status"], "pending")
        self.assertIsNone(manual["reviewer"])
        self.assertIsNone(manual["listeningApproval"])
        lines = [line for profile in manual["profiles"] for voice in profile["voices"] for line in voice["lines"]]
        self.assertEqual(len(lines), 18)
        self.assertTrue(all(line["intelligibility"] is None for line in lines))


class HarnessTests(unittest.TestCase):
    def test_operational_harness_is_ext4_external_offline_sdpa_create_new_and_no_reference_audio(self) -> None:
        shell = (ROOT / "scripts/qwen3-tts-extension.sh").read_text(encoding="utf-8")
        probe = (ROOT / "scripts/probe-qwen3-tts.py").read_text(encoding="utf-8")
        self.assertIn("uv sync --locked", shell)
        self.assertIn("uv python install", shell)
        self.assertIn("artifact path is not ext4", shell)
        self.assertIn("retired engine must remain deleted", shell)
        self.assertIn("--continue-at -", shell)
        self.assertIn("model file hash mismatch", shell)
        self.assertNotIn("flash-attn --", shell.lower())
        self.assertIn('attn_implementation="sdpa"', probe)
        self.assertIn('local_files_only=True', probe)
        self.assertIn('HF_HUB_OFFLINE', probe)
        self.assertIn('referenceAudioUsed": False', probe)
        self.assertIn('"xb"', probe)
        self.assertIn("evidence output already exists", probe)
        self.assertIn('if [[ "${1:-}" == -- ]]', shell)
        self.assertIn("gpuReturnedToBaselineAfterWorkerExit", probe)
        self.assertNotIn("reference_audio", probe)

    def test_latest_evidence_recomputes_historical_harness_and_objective_decision(self) -> None:
        evidence_path = ROOT / "docs/evidence/issue-8-qwen3-tts-custom-voice-wsl2.json"
        if not evidence_path.exists():
            self.skipTest("host evidence has not been generated yet")
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
        commit = evidence["provenance"]["generatedFromCommit"]
        source_hashes = {}
        source_paths = {
            "config": "config/qwen3-tts-custom-voice.lock.json",
            "core": "scripts/qwen3-tts/core.py",
            "probe": "scripts/probe-qwen3-tts.py",
            "pyproject": "scripts/qwen3-tts-runtime/pyproject.toml",
            "shell": "scripts/qwen3-tts-extension.sh",
            "tests": "scripts/test/qwen3-tts-extension.test.py",
            "uvLock": "scripts/qwen3-tts-runtime/uv.lock",
        }
        historical = {}
        for name, relative in source_paths.items():
            content = subprocess.run(["git", "-C", str(ROOT), "show", f"{commit}:{relative}"], check=True, capture_output=True).stdout
            source_hashes[name] = hashlib.sha256(content).hexdigest()
            historical[relative] = content
        self.assertEqual(source_hashes, evidence["provenance"]["sourceHashes"])
        self.assertEqual(CORE.derive_source_identity(source_hashes), evidence["run"]["sourceIdentity"])
        with tempfile.TemporaryDirectory() as directory:
            lock_path = Path(directory) / "lock.json"
            lock_path.write_bytes(historical["config/qwen3-tts-custom-voice.lock.json"])
            lock = CORE.load_lock(lock_path)
        objective = CORE.derive_objective_review(lock, evidence["outputs"])
        self.assertEqual(objective, evidence["review"]["objective"])
        self.assertEqual(objective["decision"], evidence["decision"])
        self.assertEqual(evidence["provenance"]["model"]["completeFileCount"], 13)
        self.assertEqual(evidence["provenance"]["model"]["revisionPayloadBytes"], 4_520_218_951)
        self.assertTrue(evidence["provenance"]["model"]["loadedFromLocalPath"])
        self.assertFalse(evidence["provenance"]["referenceAudioUsed"])
        self.assertEqual(evidence["isolation"]["attentionImplementation"], "sdpa")
        self.assertFalse(evidence["isolation"]["flashAttentionInstalled"])
        self.assertFalse(evidence["isolation"]["oldRetiredEnginesRecreated"])
        self.assertEqual(evidence["review"]["manualReady"]["status"], "pending")
        serialized = json.dumps(evidence)
        self.assertNotRegex(serialized, r"/(?:home|mnt)/")


if __name__ == "__main__":
    unittest.main()
