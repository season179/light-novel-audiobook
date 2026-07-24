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

## System architecture

The book is processed in two separate stages so a mistake does not require regenerating everything.

### Stage A: EPUB to reviewed audiobook script

1. **Deterministic EPUB extraction**
   - Read spine order, chapters, titles, paragraphs, cover, and metadata.
   - Remove navigation, duplicated headings, page furniture, formatting debris, and irrelevant footnotes.
   - Preserve italics/emphasis as annotations where useful.

2. **Text normalization**
   - Normalize smart punctuation, ellipses, dashes, abbreviations, numbers, and whitespace.
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

5. **Deterministic validation**
   - Verify every source passage is represented exactly once.
   - Reject malformed JSON, missing text, duplicated text, or invented text.
   - Flag low-confidence dialogue for human review.
   - Produce editable per-chapter JSONL manifests.

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
   - Create or select one narrator voice.
   - Create a stable synthetic reference clip and exact transcript for every recurring character.
   - Reuse the same reference assets for every line by that character.
   - Use a generic fallback voice for unresolved speakers.

8. **Segment rendering**
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
    - Join segments into chapters.
    - Export chapter files plus final M4B with chapter markers, cover, title, and author metadata.

## Runtime separation

- Standard `llama.cpp` router for the director brain: suggested port `8080`.
- `llama.cpp-omni` VoxCPM2 TTS server: suggested port `8090`.
- Prefer running brain preprocessing first, unloading it, then performing TTS rendering. This avoids VRAM contention and makes the workflow reproducible.

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

The choice is locked, but the primary model must still pass a representative-chapter acceptance test before bulk processing. Measure:

- Dialogue-speaker accuracy against a manually labeled set
- Character alias/coreference accuracy
- Thought-versus-spoken-dialogue classification
- Exact source-text preservation
- JSON-schema validity and semantic correctness
- Appropriate uncertainty reporting
- Refusal rate on representative mature passages, if present
- Speed, RAM/VRAM use, and consistency across repeated runs

Use llama.cpp JSON-schema/grammar enforcement for syntax, then deterministic validation for semantic and source fidelity. Move through the ordered fallbacks only if the primary misses an acceptance threshold or its measured performance is impractical.

## Implementation order

1. Validate the selected Gemma 4 26B-A4B director brain on a manually labeled representative chapter.
2. Define JSON schemas and fidelity checks.
3. Build EPUB extraction and normalization.
4. Build story-bible, speaker attribution, and review workflow.
5. Process and approve one representative chapter.
6. Build/test `llama.cpp-omni` and VoxCPM2.
7. Create narrator and character voice references.
8. Render and master the approved sample chapter.
9. Adjust based on listening review.
10. Process the full book with resumable generation.

## Decisions still needed

- Director-brain acceptance thresholds and maximum practical context/offload settings
- Narrator voice design/reference
- Character voice-generation policy
- Review interface: JSON/editor, spreadsheet, or lightweight local web UI
- Final audio codec/bitrate and target loudness
