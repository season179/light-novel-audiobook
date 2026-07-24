# Light Novel Audiobook

Local pipeline for converting English EPUB light novels into multi-voice audiobooks.

The project combines deterministic EPUB processing, an LLM-based audiobook director, VoxCPM2 speech generation through `llama.cpp-omni`, quality control, and audiobook assembly.

## Status

Planning and model evaluation. See [`docs/PLAN.md`](docs/PLAN.md).

## Repository boundaries

- Source code, prompts, schemas, tests, and documentation belong here.
- Books and generated audio belong in `C:\Users\WINDOWS 11\Audiobooks` and are not committed.
- Model weights and inference engines belong in WSL under `/home/windows_11/models/audiobook` and `/home/windows_11/src`.

## Planned workflow

1. Extract and normalize an EPUB.
2. Use a director LLM to identify speakers and delivery.
3. Validate a reviewable, source-faithful script.
4. Render approved segments with VoxCPM2.
5. Perform audio QC and assemble chapters/M4B output.
