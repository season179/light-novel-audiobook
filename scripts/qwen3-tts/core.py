from __future__ import annotations

import array
import hashlib
import json
import math
import re
import struct
from pathlib import Path
from typing import Any

SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
REVISION_PATTERN = re.compile(r"^[0-9a-f]{40}$")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_json_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return sha256_bytes(encoded)


def derive_source_identity(source_hashes: dict[str, str]) -> str:
    encoded = "".join(f"{name}:{source_hashes[name]}\n" for name in sorted(source_hashes)).encode()
    return sha256_bytes(encoded)


def load_lock(path: Path) -> dict[str, Any]:
    lock = json.loads(path.read_text(encoding="utf-8"))
    if lock.get("schemaVersion") != 1 or lock.get("issue") != 8:
        raise ValueError("unsupported Qwen3-TTS lock")
    scope = lock.get("scope", {})
    if scope != {
        "modelId": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
        "onlyAllowedModel": True,
        "referenceAudioAllowed": False,
    }:
        raise ValueError("model scope is not locked to CustomVoice 1.7B")
    model = lock.get("model", {})
    if model.get("repository") != scope["modelId"]:
        raise ValueError("model repository mismatch")
    if model.get("createdAt") != "2026-01-21T08:56:49.000Z":
        raise ValueError("model creation timestamp mismatch")
    if model.get("revision") != "0c0e3051f131929182e2c023b9537f8b1c68adfe":
        raise ValueError("model revision mismatch")
    if model.get("license") != "Apache-2.0":
        raise ValueError("model license mismatch")
    if model.get("huggingFaceUsedStorageBytes") != 4_523_965_995:
        raise ValueError("Hugging Face storage byte pin mismatch")
    files = model.get("files", [])
    if len(files) != 13 or len({item.get("path") for item in files}) != len(files):
        raise ValueError("complete 13-file model snapshot is required")
    for item in files:
        if not isinstance(item.get("size"), int) or item["size"] <= 0:
            raise ValueError("invalid model file size")
        if not SHA256_PATTERN.fullmatch(str(item.get("sha256", ""))):
            raise ValueError("invalid model file SHA-256")
        path = Path(str(item.get("path", "")))
        if path.is_absolute() or ".." in path.parts:
            raise ValueError("unsafe model file path")
    payload_bytes = sum(item["size"] for item in files)
    if payload_bytes != model.get("revisionPayloadBytes") or payload_bytes != 4_520_218_951:
        raise ValueError("revision payload byte total mismatch")
    expected_weights = {
        "model.safetensors": (
            3_833_402_552,
            "38b1d5971bdbd982b561cccec982669a53b0537c3cf5e9bd4778ed07bb2f5137",
        ),
        "speech_tokenizer/model.safetensors": (
            682_293_092,
            "836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258",
        ),
    }
    file_map = {item["path"]: (item["size"], item["sha256"]) for item in files}
    if any(file_map.get(path) != identity for path, identity in expected_weights.items()):
        raise ValueError("weight identity mismatch")

    runtime = lock.get("runtime", {})
    expected_runtime = {
        "package": "qwen-tts",
        "version": "0.1.1",
        "releasedAt": "2026-02-06T04:10:51.716041Z",
        "wheelFilename": "qwen_tts-0.1.1-py3-none-any.whl",
        "wheelSize": 113529,
        "wheelSha256": "11a290d8dabc7ef91a90c54478c8ab19b3edb1d85c0882313721892bdc4af15d",
        "license": "Apache-2.0",
        "sourceRepository": "https://github.com/QwenLM/Qwen3-TTS.git",
        "sourceCommit": "6cafe5582caea83df269c36b1ce62d953a9cc66b",
        "sourceTree": "3bd8928130d289476ab9139e7e863ba48563b24d",
        "licenseSha256": "a44a6081c73ad75f0255bb2bb5cab74ef1829565a895a24e53a4f11290ab7655",
        "python": "3.12.13",
        "uv": "0.11.7",
        "torch": "2.9.1",
        "torchaudio": "2.9.1",
        "attentionImplementation": "sdpa",
        "flashAttentionAllowed": False,
    }
    if runtime != expected_runtime:
        raise ValueError("runtime identity mismatch")
    if not REVISION_PATTERN.fullmatch(runtime["sourceCommit"]):
        raise ValueError("invalid runtime source revision")

    voices = lock.get("voices", [])
    if [voice.get("id") for voice in voices] != ["narrator", "character-one", "character-two"]:
        raise ValueError("exact narrator and two-character voice order is required")
    if [voice.get("speaker") for voice in voices] != ["Aiden", "Ryan", "Serena"]:
        raise ValueError("built-in speaker selection mismatch")
    if [voice.get("role") for voice in voices] != ["narrator", "character", "character"]:
        raise ValueError("voice roles mismatch")
    for voice in voices:
        if voice.get("language") != "English":
            raise ValueError("every voice must speak English")
        if sha256_bytes(voice.get("instruction", "").encode()) != voice.get("instructionSha256"):
            raise ValueError("voice instruction hash mismatch")

    lines = lock.get("lines", [])
    if [line.get("id") for line in lines] != ["line-01", "line-02", "line-03"]:
        raise ValueError("exact three comparison lines are required")
    for line in lines:
        if sha256_bytes(line.get("text", "").encode()) != line.get("textSha256"):
            raise ValueError("comparison line hash mismatch")
        if not isinstance(line.get("seed"), int):
            raise ValueError("integer sampling seed is required")

    profiles = lock.get("profiles", [])
    if [profile.get("id") for profile in profiles] != ["stock-seeded", "greedy"]:
        raise ValueError("stock and greedy profiles are required")
    if profiles[0].get("kind") != "sampling" or profiles[0]["parameters"].get("doSample") is not True:
        raise ValueError("stock profile must use sampling")
    greedy_parameters = profiles[1].get("parameters", {})
    if (
        profiles[1].get("kind") != "deterministic-candidate"
        or greedy_parameters.get("doSample") is not False
        or greedy_parameters.get("subtalkerDoSample") is not False
    ):
        raise ValueError("greedy profile must disable both samplers")
    experiment = lock.get("experiment", {})
    if experiment != {
        "primaryProfile": "stock-seeded",
        "repeatLineId": "line-01",
        "primaryMatrixRows": 3,
        "primaryMatrixColumns": 3,
        "profileCount": 2,
        "repeatsPerProfile": 3,
        "nonStreamingMode": True,
        "wavSubtype": "PCM_16",
    }:
        raise ValueError("experiment matrix mismatch")
    return lock


def _pcm16_samples(data: bytes, data_offset: int, data_size: int) -> array.array[int]:
    samples = array.array("h")
    samples.frombytes(data[data_offset : data_offset + data_size])
    if struct.pack("=H", 1) == struct.pack(">H", 1):
        samples.byteswap()
    return samples


def analyze_pcm16_wav(data: bytes) -> dict[str, Any]:
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("WAV must be RIFF/WAVE")
    declared_riff_size = struct.unpack_from("<I", data, 4)[0]
    if declared_riff_size + 8 != len(data):
        raise ValueError("WAV RIFF size does not match exact file length")
    offset = 12
    fmt: tuple[int, int, int, int, int, int] | None = None
    data_chunk: tuple[int, int] | None = None
    while offset + 8 <= len(data):
        chunk_id = data[offset : offset + 4]
        size = struct.unpack_from("<I", data, offset + 4)[0]
        content = offset + 8
        end = content + size
        padded_end = end + (size % 2)
        if end > len(data) or padded_end > len(data):
            raise ValueError("WAV chunk exceeds file")
        if chunk_id == b"fmt ":
            if fmt is not None or size != 16:
                raise ValueError("WAV must contain one canonical PCM fmt chunk")
            fmt = struct.unpack_from("<HHIIHH", data, content)
        elif chunk_id == b"data":
            if data_chunk is not None:
                raise ValueError("WAV must contain one data chunk")
            data_chunk = (content, size)
        offset = padded_end
    if offset != len(data) or fmt is None or data_chunk is None:
        raise ValueError("WAV chunk table is incomplete")
    encoding, channels, sample_rate, byte_rate, block_align, bits_per_sample = fmt
    if encoding != 1 or channels != 1 or bits_per_sample != 16:
        raise ValueError("WAV must be mono 16-bit PCM")
    if block_align != 2 or byte_rate != sample_rate * block_align:
        raise ValueError("WAV PCM rate/alignment is inconsistent")
    data_offset, data_size = data_chunk
    if data_size == 0 or data_size % block_align != 0:
        raise ValueError("WAV data is empty or misaligned")
    samples = _pcm16_samples(data, data_offset, data_size)
    frame_count = len(samples)
    duration = frame_count / sample_rate
    peak = max(abs(sample) for sample in samples)
    square_total = sum(sample * sample for sample in samples)
    clipped = sum(1 for sample in samples if abs(sample) >= 32760)
    frame_length = max(1, round(sample_rate * 0.02))
    active_frames = 0
    analyzed_frames = 0
    active_threshold = 32768 * (10 ** (-50 / 20))
    for start in range(0, frame_count, frame_length):
        frame = samples[start : start + frame_length]
        rms = math.sqrt(sum(sample * sample for sample in frame) / len(frame))
        active_frames += int(rms > active_threshold)
        analyzed_frames += 1
    rms = math.sqrt(square_total / frame_count)
    return {
        "audio": {
            "container": "RIFF/WAVE",
            "encoding": "PCM",
            "channels": channels,
            "sampleRateHz": sample_rate,
            "bitsPerSample": bits_per_sample,
            "frames": frame_count,
            "durationSeconds": duration,
            "bytes": len(data),
            "sha256": sha256_bytes(data),
        },
        "objective": {
            "peakDbfs": None if peak == 0 else 20 * math.log10(peak / 32768),
            "rmsDbfs": None if rms == 0 else 20 * math.log10(rms / 32768),
            "clippedSampleFraction": clipped / frame_count,
            "activeFrameFraction": active_frames / analyzed_frames,
        },
    }


def expected_cases(lock: dict[str, Any]) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    repeat_line = next(line for line in lock["lines"] if line["id"] == lock["experiment"]["repeatLineId"])
    for profile in lock["profiles"]:
        for voice in lock["voices"]:
            for line in lock["lines"]:
                cases.append({"profile": profile, "voice": voice, "line": line, "repetition": 0})
            cases.append({"profile": profile, "voice": voice, "line": repeat_line, "repetition": 1})
    return cases


def _case_key(item: dict[str, Any]) -> tuple[str, str, str, int]:
    return (item["profileId"], item["voiceId"], item["lineId"], item["repetition"])


def derive_objective_review(lock: dict[str, Any], outputs: list[dict[str, Any]]) -> dict[str, Any]:
    cases = expected_cases(lock)
    expected_keys = {
        (case["profile"]["id"], case["voice"]["id"], case["line"]["id"], case["repetition"])
        for case in cases
    }
    buckets: dict[tuple[str, str, str, int], list[dict[str, Any]]] = {}
    malformed_key = False
    for output in outputs:
        try:
            key = _case_key(output)
        except (KeyError, TypeError):
            malformed_key = True
            continue
        buckets.setdefault(key, []).append(output)
    exact_matrix = (
        not malformed_key
        and len(outputs) == len(cases) == 24
        and set(buckets) == expected_keys
        and all(len(bucket) == 1 for bucket in buckets.values())
    )
    primary_profile = lock["experiment"]["primaryProfile"]
    primary_matrix_exact = exact_matrix and sum(
        output.get("profileId") == primary_profile and output.get("repetition") == 0 for output in outputs
    ) == 9
    characterization_matrix_exact = exact_matrix and all(
        sum(output.get("profileId") == profile["id"] and output.get("repetition") == 0 for output in outputs) == 9
        for profile in lock["profiles"]
    )
    repeat_matrix_exact = exact_matrix and all(
        sum(output.get("profileId") == profile["id"] and output.get("repetition") == 1 for output in outputs) == 3
        for profile in lock["profiles"]
    )

    identity_valid = exact_matrix
    files_unique = exact_matrix and len({output.get("file") for output in outputs}) == len(outputs)
    no_reference_audio = True
    audio_healthy = exact_matrix
    gates = lock["reviewGates"]
    if exact_matrix:
        for sequence, case in enumerate(cases, start=1):
            key = (case["profile"]["id"], case["voice"]["id"], case["line"]["id"], case["repetition"])
            output = buckets[key][0]
            suffix = "-repeat" if case["repetition"] else ""
            expected_file = (
                f"outputs/{case['profile']['id']}/{case['voice']['id']}/"
                f"{case['line']['id']}{suffix}.wav"
            )
            identity_valid = identity_valid and all(
                [
                    output.get("sequence") == sequence,
                    output.get("profileId") == case["profile"]["id"],
                    output.get("profileKind") == case["profile"]["kind"],
                    output.get("parameters") == case["profile"]["parameters"],
                    output.get("voiceId") == case["voice"]["id"],
                    output.get("role") == case["voice"]["role"],
                    output.get("speaker") == case["voice"]["speaker"],
                    output.get("language") == case["voice"]["language"],
                    output.get("instruction") == case["voice"]["instruction"],
                    output.get("instructionSha256") == case["voice"]["instructionSha256"],
                    output.get("lineId") == case["line"]["id"],
                    output.get("text") == case["line"]["text"],
                    output.get("textSha256") == case["line"]["textSha256"],
                    output.get("seed") == case["line"]["seed"],
                    output.get("repetition") == case["repetition"],
                    output.get("file") == expected_file,
                    SHA256_PATTERN.fullmatch(str(output.get("sha256", ""))) is not None,
                    output.get("analysis", {}).get("audio", {}).get("sha256") == output.get("sha256"),
                    output.get("referenceAudioUsed") is False,
                ]
            )
            no_reference_audio = no_reference_audio and output.get("referenceAudioUsed") is False
            analysis = output.get("analysis", {})
            audio = analysis.get("audio", {})
            objective = analysis.get("objective", {})
            word_count = len(case["line"]["text"].split())
            seconds_per_word = audio.get("durationSeconds", math.inf) / word_count
            audio_healthy = audio_healthy and all(
                [
                    audio.get("container") == "RIFF/WAVE",
                    audio.get("encoding") == "PCM",
                    audio.get("sampleRateHz") == gates["requiredSampleRateHz"],
                    audio.get("channels") == gates["requiredChannels"],
                    audio.get("bitsPerSample") == gates["requiredBitsPerSample"],
                    0 < audio.get("durationSeconds", 0) <= gates["maximumDurationSeconds"],
                    gates["minimumSecondsPerWord"] <= seconds_per_word <= gates["maximumSecondsPerWord"],
                    objective.get("clippedSampleFraction", math.inf) <= gates["maximumClippedSampleFraction"],
                    objective.get("activeFrameFraction", -math.inf) >= gates["minimumActiveFrameFraction"],
                    objective.get("rmsDbfs") is not None,
                ]
            )
    else:
        identity_valid = False
        audio_healthy = False

    repeatability: list[dict[str, Any]] = []
    if exact_matrix:
        repeat_line_id = lock["experiment"]["repeatLineId"]
        for profile in lock["profiles"]:
            for voice in lock["voices"]:
                primary = buckets[(profile["id"], voice["id"], repeat_line_id, 0)][0]
                repeated = buckets[(profile["id"], voice["id"], repeat_line_id, 1)][0]
                identical = primary["sha256"] == repeated["sha256"]
                repeatability.append(
                    {
                        "profileId": profile["id"],
                        "voiceId": voice["id"],
                        "primarySha256": primary["sha256"],
                        "repeatSha256": repeated["sha256"],
                        "byteIdentical": identical,
                        "claim": (
                            "byte-repeatable for this exact run and locked environment"
                            if identical
                            else "not byte-repeatable in this exact run"
                        ),
                    }
                )
    greedy_supported = all(
        output.get("profileId") != "greedy" or output.get("apiSafety", {}).get("greedyFlagsSupported") is True
        for output in outputs
    )
    checks = {
        "exactOutputMatrix": exact_matrix,
        "primaryStockMatrixExact3x3": primary_matrix_exact,
        "profileCharacterizationMatricesExact3x3": characterization_matrix_exact,
        "repeatMatricesExact": repeat_matrix_exact,
        "outputIdentity": identity_valid,
        "fileIdentitiesUnique": files_unique,
        "noReferenceAudio": no_reference_audio,
        "greedyApiSupported": greedy_supported,
        "strictWavAndAudioHealth": audio_healthy,
    }
    feasible = all(checks.values())
    stock_repeats = [item for item in repeatability if item["profileId"] == "stock-seeded"]
    greedy_repeats = [item for item in repeatability if item["profileId"] == "greedy"]
    return {
        "checks": checks,
        "gates": gates,
        "repeatability": {
            "comparisons": repeatability,
            "stockSeededAllByteIdentical": bool(stock_repeats) and all(item["byteIdentical"] for item in stock_repeats),
            "greedyAllByteIdentical": bool(greedy_repeats) and all(item["byteIdentical"] for item in greedy_repeats),
            "scope": "Observed hashes from this run only; no cross-host or general repeatability claim.",
        },
        "decision": {
            "result": "GO for Qwen3-TTS technical evaluation" if feasible else "NO-GO for Qwen3-TTS technical evaluation",
            "listeningApproval": "PENDING human review",
            "productionReadiness": "NOT ASSESSED by this extension spike",
            "selectedModel": lock["scope"]["modelId"],
        },
    }


def create_manual_review(lock: dict[str, Any], outputs: list[dict[str, Any]], objective: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "status": "pending",
        "instructions": "Listen to every primary clip on ordinary headphones and compare it with the exact transcript. Fill every null rating before approval.",
        "scales": {
            "intelligibility": "1 unintelligible; 3 understandable with errors; 5 every word clear",
            "naturalness": "1 unusable; 3 synthetic but usable; 5 convincingly natural",
            "styleFit": "1 contradicts instruction; 3 broadly fits; 5 clearly fits",
            "stability": "1 severe artifacts; 3 minor artifacts; 5 stable throughout",
        },
        "objectiveDecision": objective["decision"],
        "profiles": [
            {
                "profileId": profile["id"],
                "voices": [
                    {
                        "voiceId": voice["id"],
                        "speaker": voice["speaker"],
                        "role": voice["role"],
                        "instruction": voice["instruction"],
                        "lines": [
                            {
                                "file": output["file"],
                                "lineId": output["lineId"],
                                "transcript": output["text"],
                                "sha256": output["sha256"],
                                "intelligibility": None,
                                "naturalness": None,
                                "styleFit": None,
                                "stability": None,
                                "notes": None,
                            }
                            for output in outputs
                            if output["profileId"] == profile["id"]
                            and output["voiceId"] == voice["id"]
                            and output["repetition"] == 0
                        ],
                        "voiceDistinctFromOthers": None,
                        "crossLineConsistency": None,
                        "notes": None,
                    }
                    for voice in lock["voices"]
                ],
            }
            for profile in lock["profiles"]
        ],
        "reviewer": None,
        "reviewedAt": None,
        "listeningApproval": None,
    }


def sanitize_text(value: str, repository_root: Path, home: Path) -> str:
    sanitized = value.replace(str(repository_root), "<repository>").replace(str(home), "<home>")
    sanitized = re.sub(r"/mnt/[a-zA-Z]/[^\s:'\"]+", "<external-path>", sanitized)
    return sanitized[:4000]
