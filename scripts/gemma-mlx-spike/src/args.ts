import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** Issue #106 pins the spike port so it cannot collide with the reserved brain (8080) or TTS (8081) ports. */
export const SPIKE_HOST = '127.0.0.1'
export const SPIKE_PORT = 8090

export const DEFAULT_HF_REPOSITORY = 'Jiunsong/SuperGemma-4-12b-abliterated-mlx-4bit'

export interface SpikeConfig {
  readonly snapshotPath: string | undefined
  readonly hfRepository: string
  readonly hfCacheDir: string
  readonly hfRevision: string | undefined
  readonly outDir: string
  readonly serverBin: string | undefined
  readonly requestFile: string | undefined
  readonly startupTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly terminateTimeoutMs: number
  readonly killTimeoutMs: number
  readonly portFreeTimeoutMs: number
  readonly confidenceThreshold: number
  readonly cancelAfterMs: number | undefined
  readonly dryRun: boolean
}

export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2))
  return resolve(path)
}

function defaultOutDir(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return resolve(homedir(), '.cache', 'light-novel-audiobook', 'gemma-mlx-spike', stamp)
}

const USAGE = `gemma-mlx-spike — issue #106 self-contained macOS spike driver

Usage: tsx src/spike.ts [options]

Model snapshot (immutable; one of):
  --snapshot <path>        Verified immutable HF snapshot directory to serve.
  --hf-repo <name>         HF repo id resolved inside the cache (default: ${DEFAULT_HF_REPOSITORY}).
  --hf-cache-dir <path>    HF hub cache root (default: ~/.cache/huggingface/hub).
  --revision <sha>         Snapshot revision to select when the cache holds more than one.

Runtime:
  --server-bin <path>      mlx_lm.server executable (default: first found on PATH).
  --out <dir>              Evidence output directory (default: ~/.cache/light-novel-audiobook/gemma-mlx-spike/<utc-stamp>).
  --request-file <path>    JSON DirectionRequest to send instead of the built-in
                           representative public synthetic request.

Budgets (milliseconds; defaults match packages/gemma-director/config/real-smoke.json):
  --startup-timeout-ms <n>     Listener-ready deadline (default 600000).
  --request-timeout-ms <n>     Direction request deadline (default 900000).
  --terminate-timeout-ms <n>   SIGTERM grace before SIGKILL (default 15000).
  --kill-timeout-ms <n>        SIGKILL settle bound (default 10000).
  --confidence-threshold <x>   Director warning threshold, 0..1 (default 0.8).

Modes:
  --cancel-after-ms <n>    Abort the in-flight request <n> ms after dispatch to
                           exercise the cancellation path instead of normal completion.
  --dry-run                Validate config, port precheck, snapshot resolution, and
                           request construction without spawning mlx_lm.server.
  --help                   Show this text.
`

function parsePositiveInt(flag: string, value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer, got: ${value}`)
  }
  return parsed
}

export function parseArgs(argv: readonly string[]): SpikeConfig {
  let snapshotPath: string | undefined
  let hfRepository = DEFAULT_HF_REPOSITORY
  let hfCacheDir = resolve(homedir(), '.cache', 'huggingface', 'hub')
  let hfRevision: string | undefined
  let outDir: string | undefined
  let serverBin: string | undefined
  let requestFile: string | undefined
  let startupTimeoutMs = 600_000
  let requestTimeoutMs = 900_000
  let terminateTimeoutMs = 15_000
  let killTimeoutMs = 10_000
  let portFreeTimeoutMs = 10_000
  let confidenceThreshold = 0.8
  let cancelAfterMs: number | undefined
  let dryRun = false

  const takeValue = (flag: string, index: number): string => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`)
    }
    return value
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--help':
        console.log(USAGE)
        process.exit(0)
      case '--snapshot':
        snapshotPath = expandHome(takeValue(arg, index))
        index += 1
        break
      case '--hf-repo':
        hfRepository = takeValue(arg, index)
        index += 1
        break
      case '--hf-cache-dir':
        hfCacheDir = expandHome(takeValue(arg, index))
        index += 1
        break
      case '--revision':
        hfRevision = takeValue(arg, index)
        index += 1
        break
      case '--out':
        outDir = expandHome(takeValue(arg, index))
        index += 1
        break
      case '--server-bin':
        serverBin = expandHome(takeValue(arg, index))
        index += 1
        break
      case '--request-file':
        requestFile = expandHome(takeValue(arg, index))
        index += 1
        break
      case '--startup-timeout-ms':
        startupTimeoutMs = parsePositiveInt(arg, takeValue(arg, index))
        index += 1
        break
      case '--request-timeout-ms':
        requestTimeoutMs = parsePositiveInt(arg, takeValue(arg, index))
        index += 1
        break
      case '--terminate-timeout-ms':
        terminateTimeoutMs = parsePositiveInt(arg, takeValue(arg, index))
        index += 1
        break
      case '--kill-timeout-ms':
        killTimeoutMs = parsePositiveInt(arg, takeValue(arg, index))
        index += 1
        break
      case '--confidence-threshold': {
        const raw = takeValue(arg, index)
        const parsed = Number(raw)
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          throw new Error(`--confidence-threshold must be between zero and one, got: ${raw}`)
        }
        confidenceThreshold = parsed
        index += 1
        break
      }
      case '--cancel-after-ms':
        cancelAfterMs = parsePositiveInt(arg, takeValue(arg, index))
        index += 1
        break
      case '--dry-run':
        dryRun = true
        break
      default:
        throw new Error(`Unknown argument: ${String(arg)}\n\n${USAGE}`)
    }
  }

  if (snapshotPath !== undefined && hfRevision !== undefined) {
    throw new Error('--snapshot already pins an immutable path; do not combine it with --revision')
  }
  if (cancelAfterMs !== undefined && cancelAfterMs >= requestTimeoutMs) {
    throw new Error('--cancel-after-ms must be below the request timeout')
  }

  return {
    snapshotPath,
    hfRepository,
    hfCacheDir,
    hfRevision,
    outDir: outDir ?? defaultOutDir(),
    serverBin,
    requestFile,
    startupTimeoutMs,
    requestTimeoutMs,
    terminateTimeoutMs,
    killTimeoutMs,
    portFreeTimeoutMs,
    confidenceThreshold,
    cancelAfterMs,
    dryRun,
  }
}
