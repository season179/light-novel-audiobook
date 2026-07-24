# Light Novel Audiobook Plan

Updated: 2026-07-24

## Confirmed requirements

- Input: English EPUB
- Output: chapter audio and final audiobook (preferably M4B with chapters, cover, and metadata)
- TTS: VoxCPM2 through `llama.cpp-omni`
- Performance target: local RTX 5070 Ti 16 GB, 64 GB system RAM
- Director brain: official Google Gemma 4 26B-A4B IT QAT Q4_0 GGUF
- Casting target: narrator plus persistent character voices
- Unknown speakers: use a fallback dialogue voice and flag for review
- Preserve the source text: the LLM may classify/direct text, but must not rewrite or invent it
- Implement the application in strict TypeScript 7 with object-oriented programming and pragmatic domain-driven design (DDD)
- Use the TanStack ecosystem for AI integration and the local review application
- Use direct unprivileged HTTP loopback endpoints for the current runtime milestone
- Use Biome for TypeScript formatting, linting, and import organization
- Use pnpm 11 for package and workspace management; do not use npm for project commands
- Provide a local-only TanStack Start web app for importing books, reviewing scripts and voices, approving work, and monitoring generation
- Use SQLite as the source of truth for project state, review decisions, and jobs
- Require no user-provided voice recordings; create synthetic voice candidates locally
- Start, stop, and inspect the complete local system through one launcher command
- Run a preflight estimate before generation and warn about large disk use or insufficient free space
- Save numbered output versions and never overwrite an existing audiobook automatically
- Require no login and bind all services to the local machine only
- Make both the director LLM and TTS engine easy to replace through stable interfaces and configuration
- Support side-by-side model experiments without changing domain code or overwriting previous results
- Keep the business rules independent from model servers, file formats, databases, and user-interface frameworks

## Software design and framework strategy

The application will be a **modular TypeScript 7 monolith** on Node.js 24 or newer, not a collection of microservices. It will use strict TypeScript settings, object-oriented domain models, and pragmatic DDD so audiobook rules remain understandable, testable, and independent of infrastructure.

Planned domain areas (bounded contexts):

- **Book ingestion**: EPUB, chapters, source passages, normalization, and provenance
- **Direction**: scenes, segments, speaker attribution, delivery notes, and uncertainty
- **Casting**: characters, aliases, voices, pronunciations, and the story bible
- **Rendering**: render jobs, model parameters, retries, and generated clips
- **Quality and review**: validation findings, review decisions, and approvals
- **Assembly**: chapter audio, mastering, metadata, and final audiobook export

Use entities and value objects for concepts such as `Book`, `Chapter`, `SourcePassage`, `Segment`, `Character`, `VoiceProfile`, and `RenderJob`. Domain services will enforce cross-object rules, especially exact source-text coverage, stable character voices, and resumable rendering. Repository interfaces will keep SQLite and filesystem details out of the domain.

Infrastructure will connect through explicit adapters for EPUB parsing, director LLMs, TTS engines, the filesystem, and FFmpeg. Gemma and VoxCPM2 are the initial implementations, not hard dependencies of the domain or application layers. Application services will coordinate use cases such as importing a book, directing a chapter, approving a script, rendering pending segments, and assembling an audiobook.

### Replaceable model providers

- Define stable application-facing interfaces such as `DirectorModel` and `SpeechEngine`.
- Select implementations through named configuration profiles; do not scatter provider names, model IDs, endpoints, or parameters through business code.
- Each adapter must declare its capabilities, supported schema/features, health check, and model identity.
- Keep prompts, schemas, pronunciation data, and model parameters versioned separately from adapter code.
- Record adapter, model, model hash/version, prompt/schema versions, seed, and parameters in every experiment and output manifest.
- Allow the same representative chapter to run against multiple profiles and compare accuracy, speed, memory use, disk use, and listening-review results.
- Never overwrite earlier experiment or audiobook versions when switching models.
- Require new LLM and TTS adapters to pass shared contract tests plus the relevant acceptance tests before bulk use.

### Framework decision

Use the **TanStack ecosystem** at the application boundaries while keeping the core domain framework-independent:

- **TanStack AI** with its OpenAI-compatible adapter for structured calls to the local llama.cpp director server
- **TanStack Start** for the local-only browser-based review application
- **TanStack Query, Form, Table, and Virtual** where useful for review queues, script editing, and large chapter manifests
- **Zod / JSON Schema** for input, output, and LLM-response validation; domain objects should remain plain TypeScript classes where practical
- **Vitest** for unit, fidelity, integration, and resume/restart tests
- **Biome** as the standard formatter, linter, and import organizer, enforced locally and in CI
- **pnpm 11** with a committed lockfile and pinned `packageManager` version for reproducible installs
- A dedicated CLI/background worker for long-running processing and rendering; these jobs must not depend on a web-request lifetime
- One launcher CLI with `start`, `stop`, and `status` actions for the web app, worker, llama.cpp router, and llama.cpp-omni TTS server
- A custom HTTP adapter for VoxCPM2 because its llama.cpp-omni TTS API is separate from the director model API
- Direct unprivileged HTTP loopback endpoints for the current milestone: review app `127.0.0.1:3000`, brain `127.0.0.1:8080`, and TTS `127.0.0.1:8081`

The launcher binds only to `127.0.0.1`, fails closed if a configured port is occupied, and atomically records the effective endpoints in its runtime manifest. It displays `http://localhost:3000` for the Windows browser while service-to-service configuration uses explicit `127.0.0.1` URLs. Ports remain configurable, but their stable defaults are not silently replaced with dynamic ports. The review server accepts only the exact configured `Host` and `Origin` values, uses restrictive non-wildcard CORS, and requires an anti-CSRF token for every state-changing request. Model endpoints reject browser `Origin`/fetch metadata and emit no browser CORS permission. Portless is deferred and may be reconsidered after the core runtime and launcher work reliably; it is not a current dependency or acceptance requirement.

### Storage and background jobs

- SQLite is the source of truth for books, passages, scripts, cast data, reviews, approvals, and job state.
- JSONL is an export/import and inspection format, not the primary database.
- Large files such as EPUBs, reference voices, and audio stay in the workspace; SQLite stores their paths, hashes, and metadata.
- Use versioned database migrations and create a backup before each migration.
- The web app and CLI submit jobs to SQLite. A separate Node.js worker claims them using leases and heartbeats, retries safely, and resumes abandoned jobs after a crash.
- The launcher starts and stops all WSL2 runtime components together. The Windows browser is an unmanaged client. Graceful stop checkpoints active work so the next start can resume it safely.
- The worker loads only the model needed for the current stage, unloading the director before bulk TTS to avoid VRAM contention.
- Jobs and outputs use stable IDs and input hashes. A changed approved script, voice, model, or render setting marks dependent audio as stale instead of silently reusing it.

First prove that TanStack AI correctly passes llama.cpp JSON-schema constraints, model IDs, errors, and cancellation through the local router. Do not put business rules inside TanStack AI, TanStack Start, React components, Zod schemas, EPUB adapters, or inference clients. Add a larger orchestration framework only if the manifest-based resumable workflow proves insufficient.

## System architecture

The book is processed in two separate stages so a mistake does not require regenerating everything.

### Stage A: EPUB to reviewed audiobook script

1. **Deterministic EPUB extraction**
   - Read spine order, chapters, titles, paragraphs, cover, and metadata.
   - Detect unusual structure such as missing or conflicting navigation, repeated chapters, side stories, image-heavy pages, low-text sections, and ambiguous footnotes.
   - Classify obvious navigation, duplicated headings, page furniture, formatting debris, and irrelevant footnotes as non-story content.
   - Ask the director LLM to classify genuinely ambiguous sections using book context, while preserving the exact extracted content and reporting uncertainty.
   - Never let the LLM silently discard, reorder, or rewrite content. Uncertain structural decisions go to review.
   - Record every exclusion's location, exact text/hash, classification, reason, and decision source in an audit log.
   - Preserve italics/emphasis as annotations where useful.

2. **Text normalization**
   - Store immutable `source_text` exactly as extracted for every source passage.
   - Create separate, derived `render_text` and pronunciation annotations for deterministic speech-friendly handling of punctuation, abbreviations, numbers, and names.
   - Record every transformation and keep a mapping back to `source_text`; never overwrite it.
   - Maintain a pronunciation dictionary for character/place names.
   - Never silently alter story meaning.

3. **LLM “director brain”**
   - Process scenes with chapter context and a rolling story bible.
   - Classify narration, spoken dialogue, internal thought, letters/messages, and sound cues.
   - Attribute dialogue to characters.
   - Assign restrained delivery guidance: emotion, pace, volume, and emphasis.
   - Return schema-constrained JSON only.
   - Include confidence scores and explanations for uncertain speaker assignments.

4. **Story bible and cast registry**
   - Track canonical character IDs, aliases, pronouns, relationships, descriptions, and pronunciations.
   - Map each character to one stable voice ID.
   - Never automatically merge similarly named characters without evidence.

5. **Deterministic validation and review**
   - Verify every immutable `source_text` passage is represented exactly once.
   - Reject malformed JSON, missing text, duplicated text, invented text, or untracked render-text changes.
   - Fidelity errors always block approval and rendering.
   - Low-confidence or unresolved speakers require a human choice: assign a speaker or explicitly approve the fallback voice.
   - Use chapter states: `draft`, `needs_review`, `approved`, `rendering`, and `rendered`.
   - Record the approved script hash and reviewer decision. Any later upstream change invalidates approval and marks dependent audio as stale.
   - Export editable per-chapter JSONL manifests when needed.

Example segment:

```json
{
  "chapter": 3,
  "segment_id": "ch03-0042",
  "kind": "dialogue",
  "speaker": "alice",
  "voice": "alice",
  "text": "We shouldn't be here.",
  "emotion": "uneasy",
  "confidence": 0.94,
  "pause_after_ms": 450
}
```

### Stage B: Reviewed script to audiobook

6. **VoxCPM2 runtime**
   - Build `llama.cpp-omni` with CUDA in WSL2.
   - Download `VoxCPM2-BaseLM-Q8_0.gguf` and `VoxCPM2-Acoustic-F16.gguf` (~3.6 GB total).
   - Build both `voxcpm2-cli` for testing and persistent `llama-tts-server` for production rendering.
   - Keep this installation isolated from the standard llama.cpp router used by the brain.

7. **Voice creation and consistency**
   - Require no user-provided recordings.
   - Generate local synthetic voice candidates for the narrator and recurring characters from the approved cast/story-bible information.
   - Let the user preview the recommended candidates and approve or regenerate them before bulk rendering.
   - Save one stable reference clip and exact transcript for every approved voice.
   - Reuse the same reference assets for every line by that character.
   - Use a generic fallback voice only when the user explicitly approves an unresolved speaker.

8. **Generation preflight and segment rendering**
   - Before rendering, show estimated audiobook duration, segment count, generation time range, temporary storage, final storage, and remaining free disk space.
   - Include headroom for retries and intermediate WAV/FLAC files in the estimate.
   - Block generation when the estimate cannot fit while preserving a safety reserve.
   - Warn and require confirmation when generation is expected to consume over 20% of currently free space or leave less than 20 GB or 10% of the volume free, whichever reserve is larger.
   - Split at natural sentence/paragraph boundaries into short clips.
   - Keep the TTS server loaded across all requests.
   - Store each WAV by stable segment ID.
   - Record model, voice, seed, parameters, and source hash for reproducibility.
   - Support safe resume without regenerating completed segments.

9. **Automated quality control**
   - Detect empty, clipped, unusually short/long, repeated, or corrupted audio.
   - Optionally transcribe generated clips and compare them with source text.
   - Retry failed clips with controlled parameter/seed changes.
   - Send persistent failures to the review queue.

10. **Assembly and mastering**
    - Trim excessive silence and insert script-defined pauses.
    - Apply conservative loudness normalization without flattening expression.
    - Join segments into 48 kHz, 24-bit FLAC chapter masters.
    - Export the final M4B as mono AAC-LC at 64 kbps, targeting -18 LUFS integrated loudness and no more than -3 dB true peak.
    - Never overwrite an export. Use names such as `<title>-v001.m4b` and `<title>-v001-ch01.flac`, incrementing the version for each changed approved script, cast, model, or render configuration.
    - Include a version manifest containing the exact input and parameter hashes.
    - Include chapter markers, cover, title, author, and other available book metadata.

## Runtime separation

- The standard `llama.cpp` director router and `llama.cpp-omni` VoxCPM2 TTS server use separate configured loopback ports, defaulting to 8080 and 8081.
- Application code uses the configured direct `127.0.0.1` URLs, and the launcher records the effective endpoints.
- The launcher manages both runtimes, but they remain isolated by directory, process, and port.
- Run brain preprocessing first, unload it, and then perform TTS rendering. This avoids VRAM contention and makes the workflow reproducible.
- Bind the web app, worker control endpoints, and model servers to `127.0.0.1` only. Refuse startup rather than selecting another port when a configured port is occupied.
- Enforce exact Host/Origin allowlists and anti-CSRF checks at the review HTTP boundary. Do not grant model endpoints CORS access; reject requests carrying browser Origin or fetch-metadata headers.

## Director-brain model decision (locked 2026-07-24)

### Primary model

**Google Gemma 4 26B-A4B IT QAT Q4_0** is the selected director brain.

- Official QAT GGUF: ~14.44 GB
- 25.2B total parameters, approximately 3.8B active per token
- 256K native context and native function calling
- Apache 2.0 license
- Source: https://huggingface.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf
- Use the text model only; the vision `mmproj` is unnecessary.
- Use partial GPU offload because weights, runtime buffers, and a practical context cannot all fit in 16 GB VRAM. Keep the remaining weights and cache within the 64 GB system-RAM budget.
- Begin with a practical 32K context and increase only after measuring VRAM, RAM, prompt-processing speed, and accuracy. Preserve long-range information through the rolling story bible rather than depending on the advertised maximum context.

The 26B-A4B model is preferred over 12B because its official reasoning and difficult-instruction results are materially stronger, while its mixture-of-experts architecture activates only about 4B parameters per token. The official checkpoint is preferred over community fine-tunes to minimize behavioral drift and maximize source-fidelity predictability.

### Ordered fallbacks

Use a fallback only when the primary model fails the acceptance test or proves operationally impractical:

1. **HauhauCS Gemma4 26B-A4B QAT Uncensored Balanced MTP**
   - Use if the official model refuses or obstructs legitimate processing of mature source material.
   - Q4_K_M text model: ~16.80 GB; optional MTP drafter: ~0.25 GB.
   - Requires more CPU offload than the primary model. MTP can accelerate generation but does not remove prompt-processing or memory costs.
   - Source: https://huggingface.co/HauhauCS/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP

2. **HauhauCS Gemma4 12B QAT Uncensored Balanced**
   - Use when 26B offloading is too slow or memory-heavy and mature-content reliability remains necessary.
   - Q4_K_M text model: ~7.38 GB; fully GPU-resident with useful context headroom.
   - Source: https://huggingface.co/HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced

3. **Google Gemma 4 12B IT QAT Q4_0**
   - Use when a faster, fully GPU-resident official checkpoint is more important than the 26B model's higher reasoning quality.
   - Official GGUF: ~6.98 GB.
   - Source: https://huggingface.co/google/gemma-4-12B-it-qat-q4_0-gguf

The dense Gemma 4 31B variants are not planned fallbacks: they require substantial offload, activate all parameters per token, and are unlikely to justify their throughput penalty on this hardware. Creative-writing, roleplay, coding, novelist, and agentic Gemma fine-tunes are also excluded unless task-specific evidence shows that they improve attribution without harming source fidelity.

### Primary-model acceptance test

The choice is locked, but the primary model must still pass a representative-chapter acceptance test before bulk processing. Initial passing thresholds are:

- 100% exact source-text coverage and valid final schemas
- At least 95% dialogue-speaker and character alias/coreference accuracy
- At least 98% thought-versus-spoken-dialogue classification accuracy
- At least 90% of incorrect speaker assignments flagged for review
- 0% refusal on legitimate representative passages
- At least 95% agreement on speaker and segment kind across three repeated runs
- No crashes or out-of-memory failures; remain within 15.5 GB VRAM and 60 GB system RAM
- Complete direction of the representative chapter within 60 minutes at the initial 32K context setting

Use llama.cpp JSON-schema/grammar enforcement for syntax, then deterministic validation for semantic and source fidelity. Move through the ordered fallbacks only if the primary misses an acceptance threshold or its measured performance is impractical.

## Implementation order

1. Validate TanStack AI's OpenAI-compatible adapter with llama.cpp, then test the selected Gemma 4 26B-A4B director brain on a manually labeled representative chapter.
2. Define the domain model, bounded-context boundaries, replaceable `DirectorModel` and `SpeechEngine` interfaces, repository interfaces, JSON schemas, and fidelity checks.
3. Build EPUB extraction and normalization behind infrastructure adapters.
4. Build story-bible, speaker attribution, and review workflow as application/domain services.
5. Process and approve one representative chapter.
6. Build/test `llama.cpp-omni` and VoxCPM2 adapters.
7. Create narrator and character voice references.
8. Render and master the approved sample chapter.
9. Adjust based on listening review.
10. Process the full book with resumable generation.

## Decisions still needed

- Maximum practical director context and GPU-offload settings after benchmarking
- Exact visual layout of the local TanStack Start review UI
