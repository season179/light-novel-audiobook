/**
 * One command that takes an EPUB through all five real adapters to a real M4B.
 *
 *   pnpm pipeline:demo -- --epub <path> [options]
 *
 * Options:
 *   --epub <path>              EPUB to ingest. Required.
 *   --workspace <path>         Workspace root. Default: a fresh directory under the OS temp dir.
 *   --job-id <id>              Job ID. Default: pipeline-demo-<timestamp>.
 *   --from-chapter <n>         Start at domain chapter N (1-based). Default: 1.
 *   --chapters <n>             Keep at most N chapters, counting from --from-chapter. Default: 1.
 *   --passages <n>             Keep at most N passages per chapter. Default: 3.
 *   --characters <a,b>         Character speaker IDs to cast. Default: none (narration only).
 *   --transports fake|real     Default: fake. `real` loads actual models; see below.
 *   --director-url <url>       Real mode: loopback /v1 URL the owned llama-server binds to.
 *   --llama-runtime-root <p>   Real mode: built brain runtime root. Default: the pinned profile's.
 *   --python <path>            Real mode: pinned uv-managed interpreter.
 *   --worker <path>            Real mode: Qwen worker script.
 *   --runtime-manifest <path>  Real mode: pinned runtime manifest.
 *   --snapshot <path>          Real mode: pinned Qwen model snapshot. Default: derived from the lock.
 *   --gpu-lock <path>          Real mode: GPU lock file shared by Gemma and Qwen.
 *
 * Fake transports are the default on purpose: no GPU, no model weights, no network beyond loopback,
 * so this is safe to run anywhere and in CI. Real transports load Gemma and Qwen for real and must be
 * asked for explicitly.
 *
 * `--from-chapter` and `--chapters` are a window, not a prefix: `--from-chapter 3 --chapters 1` renders
 * chapter 3 alone. Every slice bound is bound into the extractor identity, so changing one produces a
 * different job rather than silently handing back an earlier run's audio.
 *
 * In real mode this driver *owns* the llama.cpp process: it is spawned once Gemma holds the GPU lease
 * and reaped before the lease is released, which is what keeps the two models from being co-resident.
 * There is no `--director-key`; a key is generated per run and passed to the server by file.
 *
 * Only sanitized evidence is printed — counts, hashes, byte sizes, durations, paths. Never story text.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SELECTED_GEMMA_PROFILE } from '@light-novel-audiobook/gemma-director'
import { runPipeline } from '../src/driver.js'
import { NarrationEchoDirectorServer } from '../src/fake-director-server.js'
import type { SliceLimits } from '../src/slice.js'
import {
  createFakeTransports,
  createRealTransports,
  resolveDefaultModelSnapshotPath,
} from '../src/transports.js'

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

function positiveInteger(name: string, fallback: number): number {
  const raw = flag(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`)
  }
  return value
}

function required(name: string): string {
  const value = flag(name)
  if (value === undefined || value.length === 0) throw new Error(`--${name} is required`)
  return value
}

const epubPath = path.resolve(required('epub'))
const mode = flag('transports') ?? 'fake'
if (mode !== 'fake' && mode !== 'real') throw new Error('--transports must be fake or real')

const workspaceRoot = flag('workspace')
  ? path.resolve(flag('workspace') as string)
  : await mkdtemp(path.join(tmpdir(), 'pipeline-demo-'))
const jobId = flag('job-id') ?? `pipeline-demo-${Date.now()}`
const characterSpeakerIds = (flag('characters') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0)

// Only bound when the flag is present, so the identity of an unqualified prefix run is unchanged.
const limits: SliceLimits = {
  maxChapters: positiveInteger('chapters', 1),
  maxPassagesPerChapter: positiveInteger('passages', 3),
  ...(flag('from-chapter') === undefined
    ? {}
    : { firstChapter: positiveInteger('from-chapter', 1) }),
}

const directorServer = mode === 'fake' ? new NarrationEchoDirectorServer() : undefined
await directorServer?.start()

const transports =
  mode === 'fake'
    ? await createFakeTransports(
        { runtimeDirectory: path.join(workspaceRoot, 'runtime'), repositoryRoot: REPOSITORY_ROOT },
        (directorServer as NarrationEchoDirectorServer).baseUrl,
      )
    : await createRealTransports({
        directorBaseUrl: required('director-url'),
        llamaRuntimeRoot: path.resolve(
          flag('llama-runtime-root') ?? SELECTED_GEMMA_PROFILE.defaultRuntimeRoot,
        ),
        pythonExecutable: path.resolve(required('python')),
        workerScriptPath: path.resolve(required('worker')),
        runtimeManifestPath: path.resolve(required('runtime-manifest')),
        modelSnapshotPath: path.resolve(
          flag('snapshot') ?? (await resolveDefaultModelSnapshotPath(REPOSITORY_ROOT)),
        ),
        gpuLockFilePath: path.resolve(required('gpu-lock')),
      })

process.stderr.write(
  `[driver] mode=${mode} job=${jobId} workspace=${workspaceRoot} from-chapter=${limits.firstChapter ?? 1} chapters<=${limits.maxChapters} passages<=${limits.maxPassagesPerChapter}\n`,
)

try {
  const report = await runPipeline({
    jobId,
    epubPath,
    workspaceRoot,
    repositoryRoot: REPOSITORY_ROOT,
    transports,
    limits,
    characterSpeakerIds,
    onDirectorProgress: (event) => {
      process.stderr.write(
        `[direction] ${event.state} ${event.completedPassages}/${event.totalPassages}\n`,
      )
    },
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} catch (error) {
  // Legible failure: the known blockers all surface as a typed error, and which one matters.
  const named = error as { name?: string; code?: string; message?: string }
  process.stderr.write(
    `[driver] FAILED ${named.name ?? 'Error'}${named.code ? ` (${named.code})` : ''}: ${named.message ?? String(error)}\n`,
  )
  // A real run's first stage loads a 13.4 GiB model. Without these, re-running the same command mints a
  // fresh workspace and job, so an expensive failure cannot be resumed and the old job cannot be found.
  process.stderr.write(`[driver] resume with: --job-id ${jobId} --workspace ${workspaceRoot}\n`)
  process.exitCode = 1
} finally {
  await directorServer?.stop()
}
