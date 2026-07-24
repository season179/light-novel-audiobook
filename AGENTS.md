# Project instructions

- Read `docs/PLAN.md` before making architectural changes.
- Preserve source-book text exactly through preprocessing; the LLM may classify and annotate but must not silently rewrite, omit, duplicate, or invent story text.
- Keep EPUBs, model weights, reference voices, generated audio, secrets, and user-specific workspaces out of Git.
- Design every long-running stage to be resumable and reproducible using stable IDs, hashes, manifests, and recorded model parameters.
- Prefer deterministic code for extraction, normalization, validation, and assembly. Use an LLM only for semantic tasks such as speaker attribution and delivery direction.
- Require schema validation for all LLM output and flag uncertainty for human review.
- Add tests for source fidelity and restart/resume behavior before bulk rendering.
- Keep standard llama.cpp brain inference and llama.cpp-omni TTS inference isolated by directory and port.
