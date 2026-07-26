# Running the M1 proof (issue #21)

This is the one-command acceptance run for the M1 flow: upload an EPUB in the browser flow, watch
Gemma direct it, approve the fallback voice once, let Qwen render and FFmpeg assemble, play the
chapter audio, download the numbered M4B, and prove that a crashed run resumes by reusing the
segments it already rendered instead of starting over.

You do not need to know any of that to run it.

## The one command

From the repository root, on the GPU machine:

```sh
scripts/proof-m1.sh --transports real
```

That is the whole command. The harness checks everything first (runtimes, models, ffmpeg, the GPU
being idle, the ports being free) and **refuses to start** with a named reason if anything is
missing — you will never get a cryptic failure forty minutes in. If you want to see those checks
without starting anything:

```sh
scripts/proof-m1.sh --transports real --preflight-only
```

Set `LNA_REVIEWER='Your Name'` first if you want the fallback-voice approval recorded under your
name; otherwise it is recorded as `M1 Proof Harness`.

## What it does, and what you will see

The book it reads is `tests/fixtures/epub/acceptance-m1.epub` — two short chapters of original
fixture prose (about 20 paragraphs) with narration and two speaking characters, small enough that
the whole run is **minutes, not hours**. Nothing copyrighted is touched.

The script starts the same dev server the browser uses, then drives it over the same HTTP
endpoints the browser calls, printing progress as it goes:

1. **Pre-flight** — prints every check as `ok` and stops at the first `FAIL`.
2. **Upload + start** — the EPUB goes up and generation begins.
3. **Progress** — one line whenever the stage or segment count moves, a heartbeat every 30 s.
4. **Review gate** — the book stops for unresolved speakers; the harness lists the queue (counts
   only, never text), makes the one book-wide approval, and resumes the render.
5. **Forced stop and restart** — mid-render, the harness kills the server with `SIGKILL` (a real
   crash), restarts it on the same workspace, and recovers the job. It then proves from the
   workspace database that the segments finished before the crash were **reused untouched**, only
   the rest were rendered, and the director was never asked again (0 director requests).
6. **Output check** — every chapter's audio is fetched and readable, and the numbered M4B is
   downloaded and inspected as a container: AAC stream, one chapter marker per chapter, ordered
   marker spans matching the audio duration.
7. **Evidence** — a sanitized JSON (counts, durations, hashes, byte sizes only — no text, no
   audio) lands in `docs/evidence/`.

A green run ends with `PROOF GREEN: all seven steps completed` and prints two paths:

- the **workspace** (a fresh `lna-m1-proof-real-*` directory under your temp dir, kept on
  purpose), and
- the **numbered M4B** inside it, e.g.
  `<workspace>/output/northlight-station-m1-acceptance-fixture-v001.m4b`.

Expected duration: model load plus direction plus roughly 25–40 short segments of speech — on the
order of **ten to twenty minutes**, dominated by model loading and rendering.

## Listening to the result

The proof stops its dev server when it exits. To listen in the browser, start the server against
the workspace the proof printed (every variable spelled out; this is the same environment the
harness prints at startup):

```sh
LNA_WEB_TRANSPORTS=real \
LNA_REVIEWER='Your Name' \
AUDIOBOOK_WORKSPACE_DIR=<workspace the proof printed> \
LNA_DIRECTOR_URL=http://127.0.0.1:8080/v1 \
LNA_QWEN_PYTHON="$HOME/.local/share/light-novel-audiobook/runtimes/tts/qwen3-tts/<uv-lock-sha256>/bin/python" \
LNA_QWEN_WORKER="$PWD/packages/qwen-tts/python/qwen_batch_worker.py" \
LNA_QWEN_RUNTIME_MANIFEST="$HOME/.local/share/light-novel-audiobook/runtimes/tts/qwen3-tts/<uv-lock-sha256>/manifest.json" \
LNA_GPU_LOCK="$HOME/.local/share/light-novel-audiobook/gpu/exclusive.lock" \
pnpm --filter @light-novel-audiobook/web dev
```

(`<uv-lock-sha256>` is the SHA-256 of `scripts/qwen3-tts-runtime/uv.lock`; the harness resolves it
for you and prints the exact block at startup.) Then open <http://127.0.0.1:3000>, pick the book,
and press play on any chapter — or download the M4B from the same page. You can equally play the
M4B file directly in any media player; it is a standard audiobook container with chapter markers.

## If it fails

A failing run ends with `PROOF RED:` and a specific reason. The dev server log is
`dev-server.log` inside the workspace, which is kept either way. Re-running is always safe: the
harness builds a fresh workspace each time, never overwrites an existing M4B or evidence file, and
outright refuses a workspace that already has state in it.

`--transports fake` (the default) runs the same seven steps against the app's built-in fakes — no
GPU, no models, done in seconds — which is how this harness itself is proven. In fake mode no real
audio is produced: the "M4B" there is the fake assembler's documented placeholder-WAV payload, and
the forced stop is an injected fault rather than a server kill (the fake server's state is
in-memory by design, so killing it would prove nothing about reuse).
