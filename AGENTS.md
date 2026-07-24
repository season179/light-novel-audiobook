# Project instructions

## Execution environment

- Detect the current execution environment before running platform-sensitive commands. Use signals such as `uname -s`, `OSTYPE`, `WSL_DISTRO_NAME`, and `/proc/version`; do not infer the active shell from repository paths alone.
- Use commands native to the current environment:
  - Linux or WSL2: run Bash/Linux tools directly.
  - macOS: run macOS/POSIX tools directly.
  - Native Windows: run PowerShell or Windows tools directly.
- A repository under `/mnt/<drive>/...` is still being operated from WSL2. Do not invoke `powershell.exe`, `cmd.exe`, or other Windows executables merely because the files are stored on a Windows-mounted drive.
- From WSL2, invoke a Windows executable only when the task explicitly requires Windows-host behavior, such as validating Windows process management, Windows path semantics, or host disk reporting that cannot be obtained correctly from WSL. State why the cross-environment call is needed before making it.
- Keep WSL2 runtime paths (for model weights and inference engines) distinct from Windows workspace paths. Quote paths containing spaces, and do not silently translate or rewrite paths between environments.

## Engineering rules

- Read `docs/PLAN.md` before making architectural changes.
- Preserve source-book text exactly through preprocessing; the LLM may classify and annotate but must not silently rewrite, omit, duplicate, or invent story text.
- Keep EPUBs, model weights, reference voices, generated audio, secrets, and user-specific workspaces out of Git.
- Design every long-running stage to be resumable and reproducible using stable IDs, hashes, manifests, and recorded model parameters.
- Prefer deterministic code for extraction, normalization, validation, and assembly. Use an LLM only for semantic tasks such as speaker attribution and delivery direction.
- Require schema validation for all LLM output and flag uncertainty for human review.
- Add tests for source fidelity and restart/resume behavior before bulk rendering.
- Keep standard llama.cpp brain inference and llama.cpp-omni TTS inference isolated by directory and port.
