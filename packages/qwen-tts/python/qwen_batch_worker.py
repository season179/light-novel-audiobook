#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import gc
import hashlib
import importlib.metadata
import importlib.util
import inspect
import json
import os
import platform
import random
import re
import signal
import sys
import traceback
import uuid
import wave
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 1
SEGMENT_ID = re.compile(r"^(?:ch[0-9]+-[0-9]+|book-[0-9a-f]{24}-ch[0-9]{4}-p[0-9]{6}-s[0-9]{4})$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
MODEL_REVISION = "0c0e3051f131929182e2c023b9537f8b1c68adfe"
EXPECTED_PROFILE_IDS = ["aiden-calm-narrator", "ryan-energetic-baseline", "ryan-low-weary"]
EXPECTED_PROFILES = [
    {
        "id": "aiden-calm-narrator",
        "role": "narrator",
        "speaker": "Aiden",
        "instruction": "Speak as a calm audiobook narrator with measured pacing, clear diction, and restrained warmth.",
        "instructionSha256": "89ab750b6aca87f33cf45bb27853af5558244756b7a71c2397e73715aed32569",
        "seedSalt": 9201,
        "listeningEvidenceOutputSha256": "14f815c1d532d6e331e7817bb5b11ef5cd1a4b4e8897fc1ed046a596f523ffb5",
    },
    {
        "id": "ryan-energetic-baseline",
        "role": "character",
        "speaker": "Ryan",
        "instruction": "Speak with energetic confidence and lively momentum; alert, direct, and crisp without shouting.",
        "instructionSha256": "d183f94963e48d47d999ea3411ef12fb973f4a66b7e2def5f6b22d9525da99c0",
        "seedSalt": 9204,
        "listeningEvidenceOutputSha256": "e77c6eab20bb2302579cfcb7834fe02dc710224c6d913e975f3cda5a003c7db3",
    },
    {
        "id": "ryan-low-weary",
        "role": "character-or-fallback",
        "speaker": "Ryan",
        "instruction": "Speak in a low, weary, restrained manner; tired and guarded, with slow deliberate phrasing and little emotional display.",
        "instructionSha256": "5d1475b3120ef90869104a7a9b355105050486ce5bf053427e38e2b159f34ba1",
        "seedSalt": 9205,
        "listeningEvidenceOutputSha256": "a0fc1f5663f56d23b045b25a98c52ecd7ac45eed7d630db3b8fd902569841759",
    },
]
EXPECTED_WAV = {
    "container": "RIFF/WAVE",
    "encoding": "PCM",
    "sampleRateHz": 24000,
    "channels": 1,
    "bitsPerSample": 16,
    "maximumClippedSampleFraction": 0.001,
    "minimumActiveFrameFraction": 0.15,
    "minimumSecondsPerWord": 0.08,
    "minimumUtteranceDurationSeconds": 0.32,
    "maximumSecondsPerWord": 2.0,
    "fixedUtteranceOverheadSeconds": 1.0,
    "maximumDurationSeconds": 30.0,
}


class Cancelled(BaseException):
    pass


def handle_termination(_signum: int, _frame: Any) -> None:
    raise Cancelled("render batch cancelled")


PR_SET_PDEATHSIG = 1


def bind_to_parent_lifetime() -> None:
    """Die with the orchestrating Node parent.

    The parent holds the exclusive cross-process GPU lease and spawns this worker in its own
    process group, so a SIGKILLed parent would otherwise release the lease while this process is
    still CUDA-resident and the next owner would load its weights on top of ours. PR_SET_PDEATHSIG
    makes the kernel kill us the moment the parent goes away. It is a hard exclusivity guarantee,
    so a platform that cannot arm it must fail rather than render.

    CAUTION for future callers: per prctl(2) the parent-death signal fires when the *thread* that
    created this process terminates, not when the parent process exits. Today the orchestrator
    always spawns from its main thread, so the two coincide. If the planned background worker
    (docs/PLAN.md) ever spawns this process from a Node `worker_thread`, this worker is SIGKILLed
    the moment that thread finishes -- mid-batch. Spawn from the main thread, or keep the spawning
    thread alive for the whole batch.
    """
    if sys.platform != "linux":
        raise ValueError("the pinned Qwen worker requires Linux parent-death signalling")
    import ctypes

    parent = os.getppid()
    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    if libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_PDEATHSIG, SIGKILL) failed")
    if os.getppid() != parent:
        # The parent died inside the arming window, so the signal will never arrive. Leave now
        # rather than hold the GPU behind a lease nobody owns.
        os._exit(129)


def emit(event_type: str, **values: Any) -> None:
    print(json.dumps({"protocolVersion": PROTOCOL_VERSION, "type": event_type, **values}, separators=(",", ":")), flush=True)


@contextlib.contextmanager
def _library_stdout_to_stderr():
    # stdout is the JSON protocol channel to the TS host; stderr is its log channel. The pinned
    # qwen_tts library prints an import-time "flash-attn is not installed" banner to stdout via
    # print() (#62), which the host's strict line parser treats as a malformed protocol event and
    # aborts on. Redirect fd 1 to stderr at the file-descriptor level for the heavy imports so that
    # neither Python print() nor any C-level/raw fd-1 write from a dependency can reach the protocol
    # stream (fd-level, not a sys.stdout swap, so it also catches non-Python writes).
    #
    # The flush() calls are load-bearing: stdout is block-buffered under a pipe, so a print() during
    # the import would otherwise sit in the buffer and flush back onto the protocol channel AFTER fd
    # 1 is restored. Flush first to drain pending protocol bytes, and flush again before the restore
    # so any buffered library output reaches stderr first. The outer finally restores fd 1 even if
    # the import throws, so a failure stays visible rather than leaving stdout pointed at stderr.
    sys.stdout.flush()
    saved_fd = os.dup(1)
    try:
        os.dup2(2, 1)
        try:
            yield
        finally:
            sys.stdout.flush()
    finally:
        os.dup2(saved_fd, 1)
        os.close(saved_fd)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def exact_object(value: Any, fields: set[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError(f"{name} has invalid fields")
    return value


def read_message() -> dict[str, Any]:
    line = sys.stdin.buffer.readline(16 * 1024 * 1024)
    if not line or len(line) >= 16 * 1024 * 1024:
        raise ValueError("one bounded protocol message is required")
    try:
        value = json.loads(line)
    except json.JSONDecodeError as error:
        raise ValueError("protocol message is not valid JSON") from error
    if not isinstance(value, dict):
        raise ValueError("protocol message must be an object")
    return value


def read_begin_request() -> dict[str, Any]:
    request = exact_object(
        read_message(),
        {
            "protocolVersion",
            "command",
            "productionConfigPath",
            "productionConfigSha256",
            "modelLockPath",
            "runtimeManifestPath",
            "runtimeManifestSha256",
            "uvLockPath",
            "snapshotPath",
            "outputDirectory",
            "workerSha256",
            "allowOverwriteExisting",
        },
        "begin request",
    )
    if request["protocolVersion"] != PROTOCOL_VERSION or request["command"] != "begin-batch":
        raise ValueError("unsupported command or protocol")
    for key in [
        "productionConfigPath",
        "modelLockPath",
        "runtimeManifestPath",
        "uvLockPath",
        "snapshotPath",
        "outputDirectory",
    ]:
        if not isinstance(request[key], str) or not Path(request[key]).is_absolute():
            raise ValueError(f"{key} must be an absolute path")
    for key in ["productionConfigSha256", "runtimeManifestSha256", "workerSha256"]:
        if not isinstance(request[key], str) or not SHA256.fullmatch(request[key]):
            raise ValueError(f"{key} is invalid")
    if not isinstance(request["allowOverwriteExisting"], bool):
        raise ValueError("allowOverwriteExisting must be boolean")
    return request


def validate_segment(item: Any, seen: set[str], previous_sequence: int) -> dict[str, Any]:
    item = exact_object(
        item,
        {
            "sequence",
            "segmentId",
            "text",
            "voiceProfileId",
            "seed",
            "renderIdentitySha256",
            "applicationInputIdentity",
            "delivery",
            "effectiveInstruction",
            "fallbackApproval",
        },
        "segment",
    )
    if not isinstance(item["sequence"], int) or item["sequence"] <= previous_sequence:
        raise ValueError("segment sequence must be strictly increasing")
    segment_id = item["segmentId"]
    if not isinstance(segment_id, str) or not SEGMENT_ID.fullmatch(segment_id) or segment_id in seen:
        raise ValueError("segment ID is unsafe or duplicated")
    if not isinstance(item["text"], str) or not item["text"].strip() or "\0" in item["text"]:
        raise ValueError(f"segment text is invalid: {segment_id}")
    if item["voiceProfileId"] not in EXPECTED_PROFILE_IDS:
        raise ValueError(f"voice profile is not selected: {segment_id}")
    if not isinstance(item["seed"], int) or not 1 <= item["seed"] <= 0x7FFFFFFF:
        raise ValueError(f"seed is invalid: {segment_id}")
    if not isinstance(item["renderIdentitySha256"], str) or not SHA256.fullmatch(item["renderIdentitySha256"]):
        raise ValueError(f"render identity is invalid: {segment_id}")
    if item["applicationInputIdentity"] is not None and (
        not isinstance(item["applicationInputIdentity"], str)
        or not SHA256.fullmatch(item["applicationInputIdentity"])
    ):
        raise ValueError(f"application input identity is invalid: {segment_id}")
    delivery = exact_object(item["delivery"], {"emotion", "pace", "volume", "pauseAfterMs"}, "delivery")
    if (
        not isinstance(delivery["emotion"], str)
        or not delivery["emotion"]
        or delivery["pace"] not in {"slow", "normal", "fast"}
        or delivery["volume"] not in {"soft", "normal", "loud"}
        or not isinstance(delivery["pauseAfterMs"], int)
        or not 0 <= delivery["pauseAfterMs"] <= 10000
    ):
        raise ValueError(f"delivery is invalid: {segment_id}")
    if not isinstance(item["effectiveInstruction"], str) or not item["effectiveInstruction"]:
        raise ValueError(f"effective instruction is invalid: {segment_id}")
    approval = item["fallbackApproval"]
    if approval is not None:
        approval = exact_object(approval, {"approvalId", "approvalSha256"}, "fallback approval")
        if (
            not isinstance(approval["approvalId"], str)
            or not approval["approvalId"]
            or not isinstance(approval["approvalSha256"], str)
            or not SHA256.fullmatch(approval["approvalSha256"])
        ):
            raise ValueError(f"fallback approval is invalid: {segment_id}")
    seen.add(segment_id)
    return item

def validate_runtime(config: dict[str, Any], manifest_path: Path, uv_lock_path: Path) -> None:
    runtime = config["runtime"]
    if sha256_file(uv_lock_path) != runtime["uvLockSha256"]:
        raise ValueError("uv lock identity changed")
    if platform.python_version() != runtime["python"]:
        raise ValueError("Python patch version does not match production lock")
    inventory = sorted(
        (
            {"name": distribution.metadata["Name"].lower(), "version": distribution.version}
            for distribution in importlib.metadata.distributions()
            if distribution.metadata.get("Name")
        ),
        key=lambda item: item["name"],
    )
    versions = {item["name"]: item["version"] for item in inventory}
    expected = {
        runtime["package"]: runtime["version"],
        "torch": runtime["torch"],
        "torchaudio": runtime["torchaudio"],
    }
    if any(versions.get(name) != version for name, version in expected.items()):
        raise ValueError("installed Qwen runtime package identity changed")
    if importlib.util.find_spec("flash_attn") is not None or "flash-attn" in versions:
        raise ValueError("FlashAttention is forbidden")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        manifest.get("pythonVersion") != runtime["python"]
        or manifest.get("uvLockSha256") != sha256_file(uv_lock_path)
        or manifest.get("packages") != inventory
    ):
        raise ValueError("immutable runtime manifest does not match installed environment")


def validate_snapshot(lock: dict[str, Any], snapshot: Path) -> None:
    if lock.get("scope") != {
        "modelId": MODEL_ID,
        "onlyAllowedModel": True,
        "referenceAudioAllowed": False,
    }:
        raise ValueError("model lock permits an unsupported scope")
    model = lock.get("model", {})
    if model.get("repository") != MODEL_ID or model.get("revision") != MODEL_REVISION:
        raise ValueError("model lock identity changed")
    expected = {item["path"]: item for item in model.get("files", [])}
    if len(expected) != 13:
        raise ValueError("complete 13-file model lock is required")
    actual: set[str] = set()
    for root, directories, files in os.walk(snapshot, followlinks=False):
        root_path = Path(root)
        for name in [*directories, *files]:
            if (root_path / name).is_symlink():
                raise ValueError("model snapshot symlinks are forbidden")
        actual.update(str((root_path / name).relative_to(snapshot)) for name in files)
    if actual != set(expected):
        raise ValueError("model snapshot file list changed")
    total = 0
    for relative_path, identity in expected.items():
        path = snapshot / relative_path
        size = path.stat().st_size
        total += size
        if size != identity["size"] or sha256_file(path) != identity["sha256"]:
            raise ValueError(f"model snapshot identity mismatch: {relative_path}")
    if total != model.get("revisionPayloadBytes"):
        raise ValueError("model snapshot payload size changed")


def validate_production_config(request: dict[str, Any]) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    path = Path(request["productionConfigPath"])
    if sha256_file(path) != request["productionConfigSha256"]:
        raise ValueError("production configuration hash changed between parent and worker")
    config = json.loads(path.read_text(encoding="utf-8"))
    if config.get("schemaVersion") != 1 or config.get("adapter") != {
        "id": "qwen3-tts-python-batch",
        "version": 1,
        "protocolVersion": 1,
    }:
        raise ValueError("production adapter identity changed")
    if config.get("model") != {
        "repository": MODEL_ID,
        "revision": MODEL_REVISION,
        "snapshotLockSha256": "52eb83769efd950f0fbc0d7936db0e3381b133582e2a405f8f074f4458670d27",
        "mainWeightsSha256": "38b1d5971bdbd982b561cccec982669a53b0537c3cf5e9bd4778ed07bb2f5137",
        "speechTokenizerWeightsSha256": "836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258",
    }:
        raise ValueError("production model identity changed")
    runtime = config.get("runtime", {})
    if runtime != {
        "python": "3.12.13",
        "package": "qwen-tts",
        "version": "0.1.1",
        "torch": "2.9.1",
        "torchaudio": "2.9.1",
        "uvLockSha256": "6a7d989924871b408ed0e6eea86ce21ff399033e1272c5fa19bf9a5e38c3bbd9",
        "attentionImplementation": "sdpa",
        "flashAttentionAllowed": False,
        "offline": True,
        "referenceAudioAllowed": False,
    }:
        raise ValueError("production runtime identity changed")
    generation = config.get("generation", {})
    expected_generation = {
        "language": "English",
        "doSample": True,
        "topK": 50,
        "topP": 1.0,
        "temperature": 0.9,
        "repetitionPenalty": 1.05,
        "subtalkerDoSample": True,
        "subtalkerTopK": 50,
        "subtalkerTopP": 1.0,
        "subtalkerTemperature": 0.9,
        "maxNewTokens": 8192,
        "nonStreamingMode": True,
    }
    if generation != expected_generation:
        raise ValueError("production generation settings changed")
    if config.get("wav") != EXPECTED_WAV:
        raise ValueError("production WAV validation settings changed")
    profiles = config.get("voiceProfiles", [])
    if profiles != EXPECTED_PROFILES:
        raise ValueError("selected voice profile identities changed")
    by_id = {profile["id"]: profile for profile in profiles}
    if config.get("fallbackVoiceProfileId") != "ryan-low-weary" or config.get("seedStrategy") != "sha256-profile-segment-v1":
        raise ValueError("fallback voice or seed strategy changed")
    if config.get("evidence") != {
        "humanListeningPath": "docs/evidence/issue-8-qwen3-tts-human-listening-2026-07-25.json",
        "humanListeningFileSha256": "db2a3fdae8b6d9989bd261007f53c8cd5c77a61cee8510b6f1fa025a133d67d7",
    }:
        raise ValueError("human listening evidence binding changed")
    return config, by_id


def set_seed(torch: Any, numpy: Any, seed: int) -> None:
    random.seed(seed)
    numpy.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def validate_wav(data: bytes, wav_config: dict[str, Any], text: str) -> dict[str, Any]:
    import array
    import math
    import struct

    if len(data) < 46 or data[:4] != b"RIFF" or data[8:12] != b"WAVE" or data[12:16] != b"fmt " or data[36:40] != b"data":
        raise ValueError("generated WAV is not canonical RIFF/WAVE")
    if struct.unpack_from("<I", data, 4)[0] + 8 != len(data) or struct.unpack_from("<I", data, 16)[0] != 16:
        raise ValueError("generated WAV length or fmt chunk is invalid")
    encoding, channels, sample_rate, byte_rate, block_align, bits = struct.unpack_from("<HHIIHH", data, 20)
    data_size = struct.unpack_from("<I", data, 40)[0]
    if (
        encoding != 1
        or channels != wav_config["channels"]
        or sample_rate != wav_config["sampleRateHz"]
        or bits != wav_config["bitsPerSample"]
        or byte_rate != sample_rate * 2
        or block_align != 2
        or 44 + data_size != len(data)
        or data_size == 0
        or data_size % 2
    ):
        raise ValueError("generated WAV must be nonempty mono 24 kHz 16-bit PCM")
    samples = array.array("h")
    samples.frombytes(data[44:])
    if sys.byteorder != "little":
        samples.byteswap()
    frames = len(samples)
    duration = frames / sample_rate
    words = len(text.split())
    minimum_text_duration = max(
        wav_config["minimumUtteranceDurationSeconds"],
        wav_config["minimumSecondsPerWord"] * words,
    )
    maximum_text_duration = (
        wav_config["maximumSecondsPerWord"] * words
        + wav_config["fixedUtteranceOverheadSeconds"]
    )
    clipped = sum(abs(sample) >= 32760 for sample in samples) / frames
    frame_length = max(1, round(sample_rate * 0.02))
    threshold = 32768 * (10 ** (-50 / 20))
    active = 0
    analyzed = 0
    for start in range(0, frames, frame_length):
        frame = samples[start : start + frame_length]
        rms = math.sqrt(sum(sample * sample for sample in frame) / len(frame))
        active += int(rms > threshold)
        analyzed += 1
    active_fraction = active / analyzed
    if (
        duration > wav_config["maximumDurationSeconds"]
        or duration < minimum_text_duration
        or duration > maximum_text_duration
        or clipped > wav_config["maximumClippedSampleFraction"]
        or active_fraction < wav_config["minimumActiveFrameFraction"]
    ):
        raise ValueError("generated WAV failed configured health gates")
    return {"sha256": sha256_bytes(data), "bytes": len(data), "frames": frames, "durationSeconds": duration}


def write_wav_atomic(
    output_directory: Path,
    segment_id: str,
    waveform: Any,
    sample_rate: int,
    wav_config: dict[str, Any],
    text: str,
    allow_overwrite: bool,
) -> dict[str, Any]:
    import numpy as np

    values = np.asarray(waveform, dtype=np.float32).reshape(-1)
    if values.size == 0 or not np.isfinite(values).all():
        raise ValueError("generated waveform is empty or non-finite")
    pcm = np.rint(np.clip(values, -1.0, 1.0) * 32767).astype("<i2")
    temporary = output_directory / f".{segment_id}.{uuid.uuid4().hex}.tmp"
    target = output_directory / f"{segment_id}.wav"
    try:
        with temporary.open("xb") as raw:
            with wave.open(raw, "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(sample_rate)
                output.writeframes(pcm.tobytes())
            raw.flush()
            os.fsync(raw.fileno())
        analysis = validate_wav(temporary.read_bytes(), wav_config, text)
        if allow_overwrite:
            os.replace(temporary, target)
        else:
            os.link(temporary, target)
            temporary.unlink()
        directory_fd = os.open(output_directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return analysis
    finally:
        temporary.unlink(missing_ok=True)


def fatal_detail(error: Exception, output_directory: Path | None) -> str:
    """The fatal channel reaches the driver's stderr, so it must never carry story text.

    The worker's own ValueErrors are curated and text-free and pass through. Anything else is
    reduced to its type name: a third-party exception can quote the input it failed on. The full
    traceback goes to a file beside the output -- the same trust domain as the workspace script
    database -- never to stderr or the protocol.
    """
    if isinstance(error, ValueError):
        return f"{type(error).__name__}: {str(error)[:1000]}"
    detail = (
        f"{type(error).__name__} (message withheld: third-party exceptions may quote segment text)"
    )
    if output_directory is not None:
        try:
            traceback_path = output_directory / f"qwen-worker-traceback-{os.getpid()}.log"
            traceback_path.write_text(
                "".join(traceback.format_exception(error)), encoding="utf-8"
            )
            detail = f"{detail}; full traceback: {traceback_path}"
        except OSError:
            pass
    return detail


def generation_kwargs(generation: dict[str, Any]) -> dict[str, Any]:
    return {
        "do_sample": generation["doSample"],
        "top_k": generation["topK"],
        "top_p": generation["topP"],
        "temperature": generation["temperature"],
        "repetition_penalty": generation["repetitionPenalty"],
        "subtalker_dosample": generation["subtalkerDoSample"],
        "subtalker_top_k": generation["subtalkerTopK"],
        "subtalker_top_p": generation["subtalkerTopP"],
        "subtalker_temperature": generation["subtalkerTemperature"],
        "max_new_tokens": generation["maxNewTokens"],
    }


def run() -> int:
    signal.signal(signal.SIGINT, handle_termination)
    signal.signal(signal.SIGTERM, handle_termination)
    os.umask(0o077)
    tts = None
    torch = None
    active_segment: str | None = None
    output_directory: Path | None = None
    try:
        bind_to_parent_lifetime()
        request = read_begin_request()
        if os.environ.get("PYTHONHOME") or os.environ.get("PYTHONPATH"):
            raise ValueError("ambient Python import paths are forbidden")
        if sha256_file(Path(__file__).resolve()) != request["workerSha256"]:
            raise ValueError("Python worker identity changed between parent and child")
        runtime_manifest_path = Path(request["runtimeManifestPath"])
        if sha256_file(runtime_manifest_path) != request["runtimeManifestSha256"]:
            raise ValueError("runtime manifest identity changed between parent and child")
        config, profiles = validate_production_config(request)
        validate_runtime(config, runtime_manifest_path, Path(request["uvLockPath"]))
        model_lock_path = Path(request["modelLockPath"])
        if sha256_file(model_lock_path) != config["model"]["snapshotLockSha256"]:
            raise ValueError("model snapshot lock identity changed")
        lock = json.loads(model_lock_path.read_text(encoding="utf-8"))
        snapshot = Path(request["snapshotPath"]).resolve(strict=True)
        validate_snapshot(lock, snapshot)
        output_directory = Path(request["outputDirectory"]).resolve(strict=True)
        if not output_directory.is_dir() or output_directory.is_symlink():
            raise ValueError("output directory must be a real directory")
        emit("runtime-validated")

        with _library_stdout_to_stderr():
            import numpy as np
            import torch as loaded_torch
            from qwen_tts import Qwen3TTSModel

        torch = loaded_torch
        if not torch.cuda.is_available():
            raise ValueError("CUDA is unavailable")
        emit("model-loading")
        tts = Qwen3TTSModel.from_pretrained(
            str(snapshot),
            device_map="cuda:0",
            dtype=torch.bfloat16,
            attn_implementation="sdpa",
            local_files_only=True,
            use_safetensors=True,
        )
        torch.cuda.synchronize()
        if getattr(tts.model.config, "_attn_implementation", None) != "sdpa":
            raise ValueError("loaded model did not retain SDPA attention")
        tokenizer_attention = getattr(tts.model.speech_tokenizer.model.config, "_attn_implementation", None)
        if tokenizer_attention != "sdpa":
            raise ValueError("loaded speech tokenizer did not retain SDPA attention")
        speakers = set(tts.get_supported_speakers() or [])
        languages = set(tts.get_supported_languages() or [])
        if not {"aiden", "ryan"}.issubset(speakers) or "english" not in languages:
            raise ValueError("selected speakers or English are unavailable")
        signature = inspect.signature(tts.model.generate)
        required_generation_flags = set(generation_kwargs(config["generation"]))
        if not required_generation_flags.issubset(signature.parameters):
            raise ValueError("qwen-tts generation API cannot apply all locked settings")
        emit("model-loaded")

        seen: set[str] = set()
        previous_sequence = 0
        while True:
            message = read_message()
            command = message.get("command")
            if command == "end-batch":
                exact_object(message, {"protocolVersion", "command"}, "end request")
                if message.get("protocolVersion") != PROTOCOL_VERSION:
                    raise ValueError("end request protocol changed")
                break
            message = exact_object(
                message,
                {"protocolVersion", "command", "segment"},
                "render request",
            )
            if message["protocolVersion"] != PROTOCOL_VERSION or command != "render-segment":
                raise ValueError("unsupported render command or protocol")
            item = validate_segment(message["segment"], seen, previous_sequence)
            previous_sequence = item["sequence"]
            segment_id = item["segmentId"]
            active_segment = segment_id
            profile = profiles[item["voiceProfileId"]]
            expected_instruction = (
                f"{profile['instruction']} For this segment, use {item['delivery']['emotion']} emotion, "
                f"{item['delivery']['pace']} pacing, and {item['delivery']['volume']} volume while preserving the approved voice."
            )
            if item["effectiveInstruction"] != expected_instruction:
                raise ValueError(f"effective instruction identity mismatch: {segment_id}")
            is_fallback = item["fallbackApproval"] is not None
            if is_fallback and item["voiceProfileId"] != config["fallbackVoiceProfileId"]:
                raise ValueError(f"fallback did not use configured approved profile: {segment_id}")
            emit("segment-started", segmentId=segment_id, sequence=item["sequence"])
            set_seed(torch, np, item["seed"])
            wavs, sample_rate = tts.generate_custom_voice(
                text=item["text"],
                language=config["generation"]["language"],
                speaker=profile["speaker"],
                instruct=item["effectiveInstruction"],
                non_streaming_mode=config["generation"]["nonStreamingMode"],
                **generation_kwargs(config["generation"]),
            )
            torch.cuda.synchronize()
            if len(wavs) != 1:
                raise ValueError("single segment generation returned an unexpected batch size")
            analysis = write_wav_atomic(
                output_directory,
                segment_id,
                wavs[0],
                int(sample_rate),
                config["wav"],
                item["text"],
                request["allowOverwriteExisting"],
            )
            emit(
                "segment-rendered",
                segmentId=segment_id,
                sequence=item["sequence"],
                sha256=analysis["sha256"],
            )
            active_segment = None

        del tts
        tts = None
        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.synchronize()
        emit("gpu-cleanup-complete")
        emit("batch-complete")
        return 0
    except Cancelled:
        return 130
    except Exception as error:
        emit(
            "fatal",
            stage="render-batch",
            message=fatal_detail(error, output_directory),
            **({"segmentId": active_segment} if active_segment is not None else {}),
        )
        return 1
    finally:
        if tts is not None:
            del tts
        gc.collect()
        if torch is not None and torch.cuda.is_available():
            try:
                torch.cuda.empty_cache()
                torch.cuda.synchronize()
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(run())
