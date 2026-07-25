#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gc
import html
import importlib.metadata
import importlib.util
import inspect
import json
import os
import platform
import random
import shutil
import stat
import subprocess
import sys
import threading
import time
import traceback
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

SCRIPT_PATH = Path(__file__).resolve()
REPOSITORY_ROOT = SCRIPT_PATH.parent.parent
CORE_PATH = REPOSITORY_ROOT / "scripts/qwen3-tts/core.py"
sys.path.insert(0, str(CORE_PATH.parent))
from core import (  # noqa: E402
    analyze_pcm16_wav,
    create_manual_review,
    derive_objective_review,
    derive_source_identity,
    load_lock,
    sanitize_text,
    sha256_bytes,
    sha256_file,
)

LOCK_PATH = REPOSITORY_ROOT / "config/qwen3-tts-custom-voice.lock.json"
SOURCE_PATHS = {
    "config": "config/qwen3-tts-custom-voice.lock.json",
    "core": "scripts/qwen3-tts/core.py",
    "probe": "scripts/probe-qwen3-tts.py",
    "pyproject": "scripts/qwen3-tts-runtime/pyproject.toml",
    "shell": "scripts/qwen3-tts-extension.sh",
    "tests": "scripts/test/qwen3-tts-extension.test.py",
    "uvLock": "scripts/qwen3-tts-runtime/uv.lock",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def write_new(path: Path, content: bytes | str) -> None:
    mode = "xb" if isinstance(content, bytes) else "x"
    kwargs = {} if isinstance(content, bytes) else {"encoding": "utf-8"}
    with path.open(mode, **kwargs) as stream:
        stream.write(content)


def command(args: list[str], *, text: bool = True) -> str:
    result = subprocess.run(args, check=True, capture_output=True, text=text)
    return result.stdout.strip() if text else result.stdout


def existing_ancestor(path: Path) -> Path:
    candidate = path.resolve(strict=False)
    while not candidate.exists():
        if candidate.parent == candidate:
            raise ValueError(f"no existing ancestor for {path}")
        candidate = candidate.parent
    return candidate.resolve()


def contains_path(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def validate_external_roots(paths: list[Path]) -> None:
    repository = REPOSITORY_ROOT.resolve()
    canonical = [path.resolve(strict=False) for path in paths]
    for path in canonical:
        if contains_path(repository, path) or contains_path(path, repository):
            raise ValueError("external artifact root overlaps Git")
        ancestor = existing_ancestor(path)
        if command(["findmnt", "-n", "-o", "FSTYPE", "-T", str(ancestor)]) != "ext4":
            raise ValueError(f"external artifact root is not ext4: {path.name}")
    for index, left in enumerate(canonical):
        for right in canonical[index + 1 :]:
            if contains_path(left, right) or contains_path(right, left):
                raise ValueError("external artifact roots overlap")


def check_private_permissions(root: Path, *, forbid_symlinks: bool = True) -> None:
    for path in [root, *root.rglob("*")]:
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            if forbid_symlinks:
                raise ValueError("symlinks are forbidden in immutable Qwen assets")
            continue
        if info.st_mode & 0o077:
            raise ValueError(f"group/other permission found under {root.name}")


def validate_snapshot(lock: dict[str, Any], snapshot: Path) -> dict[str, Any]:
    expected = {item["path"]: item for item in lock["model"]["files"]}
    actual = {
        str(path.relative_to(snapshot))
        for path in snapshot.rglob("*")
        if path.is_file()
    }
    if actual != set(expected):
        raise ValueError("snapshot is missing files or contains unexpected files")
    files = []
    total = 0
    for relative_path, identity in expected.items():
        path = snapshot / relative_path
        size = path.stat().st_size
        digest = sha256_file(path)
        if size != identity["size"] or digest != identity["sha256"]:
            raise ValueError(f"snapshot identity mismatch: {relative_path}")
        total += size
        files.append({"path": relative_path, "size": size, "sha256": digest})
    if total != lock["model"]["revisionPayloadBytes"]:
        raise ValueError("snapshot payload total mismatch")
    check_private_permissions(snapshot)
    return {"fileCount": len(files), "payloadBytes": total, "files": files}


def installed_inventory() -> list[dict[str, str]]:
    inventory = []
    for distribution in importlib.metadata.distributions():
        name = distribution.metadata.get("Name")
        if name:
            inventory.append({"name": name.lower(), "version": distribution.version})
    return sorted(inventory, key=lambda item: item["name"])


def validate_runtime(lock: dict[str, Any], runtime_manifest: Path) -> dict[str, Any]:
    manifest = json.loads(runtime_manifest.read_text(encoding="utf-8"))
    expected_python = lock["runtime"]["python"]
    if platform.python_version() != expected_python:
        raise ValueError("Python patch version does not match lock")
    expected_versions = {
        "qwen-tts": lock["runtime"]["version"],
        "torch": lock["runtime"]["torch"],
        "torchaudio": lock["runtime"]["torchaudio"],
    }
    inventory = installed_inventory()
    by_name = {item["name"]: item["version"] for item in inventory}
    if any(by_name.get(name) != version for name, version in expected_versions.items()):
        raise ValueError("installed runtime version mismatch")
    if importlib.util.find_spec("flash_attn") is not None or "flash-attn" in by_name:
        raise ValueError("FlashAttention is forbidden for this run")
    if manifest.get("pythonVersion") != expected_python:
        raise ValueError("runtime manifest Python mismatch")
    if manifest.get("uvVersion") != f"uv {lock['runtime']['uv']}":
        raise ValueError("runtime manifest uv mismatch")
    if manifest.get("uvLockSha256") != sha256_file(REPOSITORY_ROOT / SOURCE_PATHS["uvLock"]):
        raise ValueError("runtime manifest lock mismatch")
    if manifest.get("packages") != inventory:
        raise ValueError("installed package inventory changed after setup")
    check_private_permissions(runtime_manifest.parent, forbid_symlinks=False)
    return {
        "pythonVersion": platform.python_version(),
        "uvVersion": manifest["uvVersion"],
        "uvLockSha256": manifest["uvLockSha256"],
        "environmentManifestSha256": sha256_file(runtime_manifest),
        "packageCount": len(inventory),
        "packages": inventory,
    }


def git_harness_identity() -> dict[str, Any]:
    commit = command(["git", "-C", str(REPOSITORY_ROOT), "rev-parse", "HEAD"])
    hashes: dict[str, str] = {}
    for name, relative_path in SOURCE_PATHS.items():
        current = (REPOSITORY_ROOT / relative_path).read_bytes()
        committed = subprocess.run(
            ["git", "-C", str(REPOSITORY_ROOT), "show", f"{commit}:{relative_path}"],
            check=True,
            capture_output=True,
        ).stdout
        if current != committed:
            raise ValueError(f"harness differs from HEAD: {relative_path}")
        hashes[name] = sha256_bytes(current)
    identity = derive_source_identity(hashes)
    expected = os.environ.get("QWEN3_TTS_SOURCE_IDENTITY")
    if expected != identity:
        raise ValueError("harness source identity mismatch")
    return {"generatedFromCommit": commit, "sourceHashes": hashes, "sourceIdentity": identity}


def gpu_sample() -> dict[str, Any]:
    output = command(
        [
            "nvidia-smi",
            "--query-gpu=name,memory.total,memory.used,utilization.gpu",
            "--format=csv,noheader,nounits",
        ]
    )
    rows = [row for row in output.splitlines() if row.strip()]
    if len(rows) != 1:
        raise ValueError("exactly one GPU is required")
    name, total, used, utilization = [part.strip() for part in rows[0].split(",")]
    return {
        "name": name,
        "memoryTotalMiB": int(total),
        "memoryUsedMiB": int(used),
        "utilizationPercent": int(utilization),
    }


def process_rss_mib(pid: int) -> float | None:
    try:
        for line in Path(f"/proc/{pid}/status").read_text(encoding="utf-8").splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) / 1024
    except (FileNotFoundError, ProcessLookupError):
        return None
    return None


def memory_sample(pid: int) -> dict[str, Any]:
    values: dict[str, int] = {}
    for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
        key, value = line.split(":", 1)
        if key in {"MemTotal", "MemAvailable"}:
            values[key] = int(value.split()[0])
    return {
        "processRssMiB": process_rss_mib(pid),
        "systemTotalMiB": values["MemTotal"] / 1024,
        "systemAvailableMiB": values["MemAvailable"] / 1024,
        "systemUsedMiB": (values["MemTotal"] - values["MemAvailable"]) / 1024,
    }


class ResourceMonitor:
    def __init__(self, pid: int):
        self.pid = pid
        self.samples: list[dict[str, Any]] = []
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self.stop_event.is_set():
            try:
                self.samples.append({"gpu": gpu_sample(), "memory": memory_sample(self.pid)})
            except (OSError, ValueError, subprocess.SubprocessError):
                pass
            self.stop_event.wait(0.2)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> dict[str, Any]:
        self.stop_event.set()
        self.thread.join(timeout=5)
        if not self.samples:
            raise ValueError("resource monitor captured no samples")
        rss = [sample["memory"]["processRssMiB"] for sample in self.samples if sample["memory"]["processRssMiB"] is not None]
        return {
            "sampleCount": len(self.samples),
            "peakGpuMemoryUsedMiB": max(sample["gpu"]["memoryUsedMiB"] for sample in self.samples),
            "peakGpuUtilizationPercent": max(sample["gpu"]["utilizationPercent"] for sample in self.samples),
            "peakProcessRssMiB": max(rss) if rss else None,
            "peakSystemUsedMiB": max(sample["memory"]["systemUsedMiB"] for sample in self.samples),
            "systemTotalMiB": self.samples[0]["memory"]["systemTotalMiB"],
        }


def set_seed(seed: int) -> None:
    import torch

    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def write_wav(path: Path, waveform: np.ndarray, sample_rate: int) -> dict[str, Any]:
    values = np.asarray(waveform, dtype=np.float32).reshape(-1)
    if values.size == 0 or not np.isfinite(values).all():
        raise ValueError("generated waveform is empty or non-finite")
    source_peak = float(np.max(np.abs(values)))
    pcm = np.rint(np.clip(values, -1.0, 1.0) * 32767).astype("<i2")
    with path.open("xb") as stream:
        with wave.open(stream, "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(sample_rate)
            output.writeframes(pcm.tobytes())
    data = path.read_bytes()
    analysis = analyze_pcm16_wav(data)
    analysis["sourceFloat"] = {"peakAbsolute": source_peak, "outOfRangeSampleFraction": float(np.mean(np.abs(values) > 1.0))}
    return analysis


def profile_kwargs(profile: dict[str, Any]) -> dict[str, Any]:
    if profile["id"] == "stock-seeded":
        return {}
    return {"do_sample": False, "subtalker_dosample": False}


def worker(args: argparse.Namespace) -> int:
    os.umask(0o077)
    lock = load_lock(LOCK_PATH)
    snapshot = Path(args.snapshot).resolve()
    output_root = Path(args.output_root).resolve()
    result_path = Path(args.result).resolve()
    runtime_manifest = Path(args.runtime_manifest).resolve()
    try:
        runtime = validate_runtime(lock, runtime_manifest)
        snapshot_identity = validate_snapshot(lock, snapshot)
        import torch
        from qwen_tts import Qwen3TTSModel

        if not torch.cuda.is_available():
            raise ValueError("CUDA is unavailable")
        if lock["runtime"]["attentionImplementation"] != "sdpa":
            raise ValueError("attention lock must be SDPA")
        load_started = time.perf_counter()
        tts = Qwen3TTSModel.from_pretrained(
            str(snapshot),
            device_map="cuda:0",
            dtype=torch.bfloat16,
            attn_implementation="sdpa",
            local_files_only=True,
            use_safetensors=True,
        )
        torch.cuda.synchronize()
        load_seconds = time.perf_counter() - load_started
        speakers = tts.get_supported_speakers()
        languages = tts.get_supported_languages()
        required_speakers = {voice["speaker"].lower() for voice in lock["voices"]}
        if speakers is None or not required_speakers.issubset(set(speakers)):
            raise ValueError("required built-in speakers are unavailable")
        if languages is None or "english" not in set(languages):
            raise ValueError("English is unavailable")
        generate_signature = inspect.signature(tts.model.generate)
        greedy_supported = {"do_sample", "subtalker_dosample"}.issubset(generate_signature.parameters)
        if not greedy_supported:
            raise ValueError("runtime API cannot safely disable both samplers")
        defaults = dict(tts.generate_defaults)
        expected_stock = lock["profiles"][0]["parameters"]
        normalized_defaults = {
            "doSample": defaults.get("do_sample"),
            "topK": defaults.get("top_k"),
            "topP": defaults.get("top_p"),
            "temperature": defaults.get("temperature"),
            "repetitionPenalty": defaults.get("repetition_penalty"),
            "subtalkerDoSample": defaults.get("subtalker_dosample"),
            "subtalkerTopK": defaults.get("subtalker_top_k"),
            "subtalkerTopP": defaults.get("subtalker_top_p"),
            "subtalkerTemperature": defaults.get("subtalker_temperature"),
            "maxNewTokens": defaults.get("max_new_tokens"),
        }
        if normalized_defaults != expected_stock:
            raise ValueError("model stock generation defaults changed")
        attention = {
            "requested": "sdpa",
            "modelConfig": getattr(tts.model.config, "_attn_implementation", None),
            "speechTokenizerConfig": getattr(tts.model.speech_tokenizer.model.config, "_attn_implementation", None),
            "flashAttentionInstalled": importlib.util.find_spec("flash_attn") is not None,
        }
        if attention["modelConfig"] != "sdpa" or attention["speechTokenizerConfig"] != "sdpa":
            raise ValueError("loaded model did not retain SDPA attention")

        outputs: list[dict[str, Any]] = []
        sequence = 0
        repeat_line = next(line for line in lock["lines"] if line["id"] == lock["experiment"]["repeatLineId"])
        for profile in lock["profiles"]:
            for voice in lock["voices"]:
                voice_root = output_root / "outputs" / profile["id"] / voice["id"]
                voice_root.mkdir(parents=True, mode=0o700)
                cases = [(line, 0) for line in lock["lines"]] + [(repeat_line, 1)]
                for line, repetition in cases:
                    set_seed(line["seed"])
                    started = time.perf_counter()
                    wavs, sample_rate = tts.generate_custom_voice(
                        text=line["text"],
                        language=voice["language"],
                        speaker=voice["speaker"],
                        instruct=voice["instruction"],
                        non_streaming_mode=True,
                        **profile_kwargs(profile),
                    )
                    torch.cuda.synchronize()
                    elapsed = time.perf_counter() - started
                    if len(wavs) != 1:
                        raise ValueError("single generation returned an unexpected batch size")
                    suffix = "-repeat" if repetition else ""
                    relative_file = f"outputs/{profile['id']}/{voice['id']}/{line['id']}{suffix}.wav"
                    target = output_root / relative_file
                    analysis = write_wav(target, wavs[0], int(sample_rate))
                    sequence += 1
                    outputs.append(
                        {
                            "sequence": sequence,
                            "profileId": profile["id"],
                            "profileKind": profile["kind"],
                            "parameters": profile["parameters"],
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
                            "seedMethod": "Python, NumPy, torch CPU, and all CUDA RNGs reset immediately before generation",
                            "repetition": repetition,
                            "referenceAudioUsed": False,
                            "nonStreamingMode": True,
                            "apiSafety": {"greedyFlagsSupported": greedy_supported},
                            "file": relative_file,
                            "elapsedSeconds": elapsed,
                            "sha256": analysis["audio"]["sha256"],
                            "analysis": analysis,
                        }
                    )
        del tts
        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.synchronize()
        cuda_after_unload = {
            "allocatedBytes": torch.cuda.memory_allocated(),
            "reservedBytes": torch.cuda.memory_reserved(),
        }
        result = {
            "schemaVersion": 1,
            "runtime": runtime,
            "snapshot": snapshot_identity,
            "capabilities": {
                "supportedSpeakers": speakers,
                "supportedLanguages": languages,
                "requiredSpeakersPresent": True,
                "englishPresent": True,
                "greedyFlagsSupported": greedy_supported,
                "attention": attention,
                "stockGenerationDefaults": normalized_defaults,
                "processorLoadedFromLocalSnapshot": True,
                "referenceAudioUsed": False,
            },
            "timing": {"modelLoadSeconds": load_seconds, "generationSeconds": sum(item["elapsedSeconds"] for item in outputs)},
            "cudaAfterUnload": cuda_after_unload,
            "outputs": outputs,
        }
        write_new(result_path, json.dumps(result, indent=2) + "\n")
        return 0
    except Exception:
        traceback.print_exc()
        return 1


def allocate_run(base: Path, source_identity: str) -> tuple[str, Path]:
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    for _ in range(20):
        run_id = f"qwen3tts-{source_identity[:16]}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}-{os.urandom(6).hex()}"
        root = base / run_id
        try:
            root.mkdir(mode=0o700)
            return run_id, root
        except FileExistsError:
            continue
    raise ValueError("could not allocate immutable run")


def review_html(lock: dict[str, Any], outputs: list[dict[str, Any]]) -> str:
    sections = []
    for profile in lock["profiles"]:
        voices = []
        for voice in lock["voices"]:
            clips = []
            for output in outputs:
                if output["profileId"] == profile["id"] and output["voiceId"] == voice["id"] and output["repetition"] == 0:
                    clips.append(
                        f"<li><strong>{html.escape(output['lineId'])}</strong>: {html.escape(output['text'])}<br>"
                        f"<audio controls preload=\"none\" src=\"{html.escape(output['file'])}\"></audio></li>"
                    )
            voices.append(
                f"<section><h3>{html.escape(voice['id'])}: {html.escape(voice['speaker'])}</h3>"
                f"<p>{html.escape(voice['instruction'])}</p><ol>{''.join(clips)}</ol></section>"
            )
        sections.append(f"<h2>{html.escape(profile['id'])}</h2>{''.join(voices)}")
    return (
        "<!doctype html>\n<html lang=\"en\"><meta charset=\"utf-8\"><title>Issue #8 Qwen3-TTS review</title>"
        "<body><h1>Issue #8 Qwen3-TTS listening review — PENDING</h1>"
        "<p>Listen on ordinary headphones and compare every primary clip with its exact transcript and style instruction. "
        "Then complete <code>manual-review.json</code>. No reference audio was used.</p>"
        f"{''.join(sections)}</body></html>\n"
    )


def parent(args: argparse.Namespace) -> int:
    os.umask(0o077)
    lock = load_lock(LOCK_PATH)
    evidence_path = Path(args.output).resolve()
    if evidence_path.exists():
        raise ValueError("evidence output already exists; overwrites are forbidden")
    snapshot = Path(os.environ["QWEN3_TTS_MODEL_SNAPSHOT"]).resolve()
    runtime_root = Path(os.environ["QWEN3_TTS_RUNTIME_ROOT"]).resolve()
    runtime_manifest = Path(os.environ["QWEN3_TTS_RUNTIME_MANIFEST"]).resolve()
    run_base = Path(os.environ["QWEN3_TTS_RUN_BASE"]).resolve()
    raw_base = Path(os.environ["QWEN3_TTS_RAW_BASE"]).resolve()
    validate_external_roots([snapshot, runtime_root, run_base, raw_base])
    harness = git_harness_identity()
    run_id, artifact_root = allocate_run(run_base, harness["sourceIdentity"])
    raw_id, raw_root = allocate_run(raw_base, harness["sourceIdentity"])
    if raw_id == run_id:
        raise ValueError("artifact and raw run identities unexpectedly match")
    captured_at = utc_now()
    stdout_path = raw_root / "worker.stdout.log"
    stderr_path = raw_root / "worker.stderr.log"
    worker_result_path = raw_root / "worker-result.json"
    baseline_gpu = gpu_sample()
    if baseline_gpu["memoryUsedMiB"] > 1024 or baseline_gpu["utilizationPercent"] > 5:
        raise ValueError("GPU is not idle enough for isolated measurement")
    environment = os.environ.copy()
    environment.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1"})
    started = time.perf_counter()
    with stdout_path.open("xb") as stdout, stderr_path.open("xb") as stderr:
        process = subprocess.Popen(
            [
                sys.executable,
                str(SCRIPT_PATH),
                "--worker",
                "--snapshot",
                str(snapshot),
                "--output-root",
                str(artifact_root),
                "--runtime-manifest",
                str(runtime_manifest),
                "--result",
                str(worker_result_path),
            ],
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            env=environment,
        )
        monitor = ResourceMonitor(process.pid)
        monitor.start()
        return_code = process.wait()
        resources = monitor.stop()
    total_seconds = time.perf_counter() - started
    end_gpu = gpu_sample()
    if return_code != 0:
        error_text = stderr_path.read_text(encoding="utf-8", errors="replace")
        raise RuntimeError(f"Qwen worker failed: {error_text[-3000:]}")
    if not worker_result_path.exists():
        raise ValueError("worker completed without a result")
    if end_gpu["memoryUsedMiB"] > baseline_gpu["memoryUsedMiB"] + 128:
        raise ValueError("GPU memory did not return to baseline after worker exit")
    result = json.loads(worker_result_path.read_text(encoding="utf-8"))
    outputs = result["outputs"]
    objective = derive_objective_review(lock, outputs)
    if not objective["decision"]["result"].startswith("GO"):
        raise ValueError(f"objective review failed: {objective['checks']}")
    manual_review = create_manual_review(lock, outputs, objective)
    manual_path = artifact_root / "manual-review.json"
    html_path = artifact_root / "review.html"
    instructions_path = artifact_root / "review-instructions.txt"
    write_new(manual_path, json.dumps(manual_review, indent=2) + "\n")
    write_new(html_path, review_html(lock, outputs))
    write_new(
        instructions_path,
        "Issue #8 Qwen3-TTS review\n\n"
        "Serve this immutable run root locally:\n"
        "  python3 -m http.server 8098 --bind 127.0.0.1\n"
        "Open http://localhost:8098/review.html, listen to all 18 primary clips, and fill manual-review.json.\n"
        "Listening approval remains PENDING until every field is completed.\n",
    )
    artifact_files = [
        {"file": output["file"], "sha256": output["sha256"], "bytes": output["analysis"]["audio"]["bytes"]}
        for output in outputs
    ] + [
        {"file": "manual-review.json", "sha256": sha256_file(manual_path), "bytes": manual_path.stat().st_size},
        {"file": "review.html", "sha256": sha256_file(html_path), "bytes": html_path.stat().st_size},
        {"file": "review-instructions.txt", "sha256": sha256_file(instructions_path), "bytes": instructions_path.stat().st_size},
    ]
    artifact_manifest = {
        "schemaVersion": 1,
        "runId": run_id,
        "sourceIdentity": harness["sourceIdentity"],
        "immutable": True,
        "createdNew": True,
        "files": artifact_files,
    }
    artifact_manifest_path = artifact_root / "artifact-manifest.json"
    write_new(artifact_manifest_path, json.dumps(artifact_manifest, indent=2) + "\n")
    raw_manifest = {
        "schemaVersion": 1,
        "runId": raw_id,
        "artifactRunId": run_id,
        "sourceIdentity": harness["sourceIdentity"],
        "immutable": True,
        "workerExitCode": return_code,
        "files": [
            {"file": "worker.stdout.log", "sha256": sha256_file(stdout_path), "bytes": stdout_path.stat().st_size},
            {"file": "worker.stderr.log", "sha256": sha256_file(stderr_path), "bytes": stderr_path.stat().st_size},
            {"file": "worker-result.json", "sha256": sha256_file(worker_result_path), "bytes": worker_result_path.stat().st_size},
        ],
    }
    raw_manifest_path = raw_root / "manifest.json"
    write_new(raw_manifest_path, json.dumps(raw_manifest, indent=2) + "\n")
    for root in [artifact_root, raw_root]:
        for path in [root, *root.rglob("*")]:
            path.chmod(0o700 if path.is_dir() else 0o600)
        check_private_permissions(root)
    evidence = {
        "evidenceSchemaVersion": 1,
        "capturedAt": captured_at,
        "issue": 8,
        "run": {
            "runId": run_id,
            "sourceIdentity": harness["sourceIdentity"],
            "createNewImmutable": True,
            "artifactManifestSha256": sha256_file(artifact_manifest_path),
            "rawManifestSha256": sha256_file(raw_manifest_path),
        },
        "provenance": {
            **harness,
            "configurationSha256": sha256_file(LOCK_PATH),
            "model": {
                "repository": lock["model"]["repository"],
                "createdAt": lock["model"]["createdAt"],
                "revision": lock["model"]["revision"],
                "license": lock["model"]["license"],
                "huggingFaceUsedStorageBytes": lock["model"]["huggingFaceUsedStorageBytes"],
                "revisionPayloadBytes": result["snapshot"]["payloadBytes"],
                "completeFileCount": result["snapshot"]["fileCount"],
                "files": result["snapshot"]["files"],
                "loadedFromLocalPath": True,
                "localPathReason": "qwen-tts 0.1.1 processor loading does not propagate a remote revision; a fully verified local snapshot avoids revision drift",
            },
            "runtime": {
                **result["runtime"],
                "package": lock["runtime"]["package"],
                "version": lock["runtime"]["version"],
                "releasedAt": lock["runtime"]["releasedAt"],
                "wheelSha256": lock["runtime"]["wheelSha256"],
                "sourceCommit": lock["runtime"]["sourceCommit"],
                "sourceTree": lock["runtime"]["sourceTree"],
                "license": lock["runtime"]["license"],
                "torchRuntimeVersion": next(item["version"] for item in result["runtime"]["packages"] if item["name"] == "torch"),
            },
            "projectAuthoredComparisonTextOnly": True,
            "referenceAudioUsed": False,
        },
        "capabilities": result["capabilities"],
        "isolation": {
            "environment": "WSL2",
            "externalAssetsOnExt4": True,
            "assetsOutsideGit": True,
            "offlineInference": True,
            "attentionImplementation": "sdpa",
            "flashAttentionInstalled": False,
            "modelScopeRestricted": lock["scope"]["modelId"],
            "oldRetiredEnginesRecreated": False,
            "workerExited": return_code == 0,
            "gpuReturnedToBaselineAfterWorkerExit": True,
            "privatePermissionsVerified": True,
        },
        "resources": {
            "baselineGpu": baseline_gpu,
            "peak": resources,
            "endGpuAfterWorkerExit": end_gpu,
            "totalWorkerSeconds": total_seconds,
            **result["timing"],
        },
        "outputs": outputs,
        "review": {
            "objective": objective,
            "manualReady": {
                "status": manual_review["status"],
                "primaryClipCount": 18,
                "manualReviewSha256": sha256_file(manual_path),
                "reviewHtmlSha256": sha256_file(html_path),
                "reviewInstructionsSha256": sha256_file(instructions_path),
                "closureGate": "REQUIRED human listening; not completed",
                "externalRelativeFiles": ["manual-review.json", "review.html", "review-instructions.txt", "outputs/"],
            },
        },
        "decision": objective["decision"],
        "limitations": [
            "WAV validity, activity, duration, and clipping checks do not establish word-level intelligibility or naturalness.",
            "Byte-repeatability statements are limited to the recorded same-run hash pairs.",
            "Human listening remains pending; this spike does not establish production readiness.",
        ],
        "redaction": {
            "absolutePaths": "omitted",
            "processIds": "omitted",
            "rawLogs": "external only",
            "audio": "external only",
            "referenceAudio": "not used",
        },
    }
    encoded = json.dumps(evidence, indent=2) + "\n"
    if str(REPOSITORY_ROOT) in encoded or str(Path.home()) in encoded:
        raise ValueError("committed evidence contains an absolute local path")
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    write_new(evidence_path, encoded)
    print(f"Qwen3-TTS run: {run_id}")
    print(f"Decision: {evidence['decision']['result']}")
    print(f"Stock repeats byte-identical: {objective['repeatability']['stockSeededAllByteIdentical']}")
    print(f"Greedy repeats byte-identical: {objective['repeatability']['greedyAllByteIdentical']}")
    print("Manual listening closure: PENDING (required)")
    print(f"External review root: {artifact_root}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(REPOSITORY_ROOT / "docs/evidence/issue-8-qwen3-tts-custom-voice-wsl2.json"))
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--snapshot")
    parser.add_argument("--output-root")
    parser.add_argument("--runtime-manifest")
    parser.add_argument("--result")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.worker:
        required = [args.snapshot, args.output_root, args.runtime_manifest, args.result]
        if any(value is None for value in required):
            raise ValueError("worker paths are required")
        return worker(args)
    return parent(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        message = sanitize_text("".join(traceback.format_exception(error)), REPOSITORY_ROOT, Path.home())
        print(message, file=sys.stderr)
        raise SystemExit(1)
