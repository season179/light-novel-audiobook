import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * #68: under WSL2/GPU-PV, nvidia-smi's compute-apps table can list PIDs that are already dead,
 * reported as `[Not Found], [N/A]`. The lease coordinator's foreign-process diagnostic cannot tell
 * a stale row from a live uncoordinated process, and a stale row must not fail an otherwise
 * correct acquisition — but a live foreign process must keep failing it, because a second resident
 * model on this card is a guaranteed OOM. This wrapper sits in front of the real (or a fake)
 * nvidia-smi and rewrites only the compute-apps answer: a row survives unless its PID parses and
 * is provably dead. Provably dead means `/proc/<pid>` is gone (ENOENT) or reports a zombie state.
 * An unreadable or unparseable row is kept, so the guard keeps failing closed on the genuinely
 * live *and* the genuinely unknown. Every other query — and every nvidia-smi failure — passes
 * through byte-for-byte with its original exit code.
 *
 * The script is written at test time rather than shipped, because the wrapper is only ever wired
 * through the `nvidiaSmiExecutable` test seam; production acquisition keeps the stock executable.
 */
const WRAPPER_SOURCE = `#!/usr/bin/env node
'use strict'
const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')

const inner = INNER_EXECUTABLE_JSON
const args = process.argv.slice(2)

// Tri-state against /proc: 'alive' | 'dead' | 'unknown'. Only 'dead' lets a compute-apps row be
// dropped; 'unknown' is treated as alive so the foreign-process guard keeps failing closed.
function liveness(pid) {
  let stat
  try {
    stat = readFileSync('/proc/' + pid + '/stat', 'utf8')
  } catch (error) {
    return error && error.code === 'ENOENT' ? 'dead' : 'unknown'
  }
  // Tolerate spaces and parens in the comm field: state is the first field after the final ')'.
  const state = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\\s+/)[0]
  return state === 'Z' || state === 'X' ? 'dead' : 'alive'
}

const result = spawnSync(inner, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 })
if (result.error) {
  process.stderr.write(String(result.error) + '\\n')
  process.exit(1)
}
if (result.stderr) process.stderr.write(result.stderr)

const isComputeApps = args.some(function (arg) {
  return arg.startsWith('--query-compute-apps=')
})
// Any failure, and any query that is not the compute-apps table, passes through untouched so the
// coordinator's own fail-closed handling of an unreadable nvidia-smi is preserved exactly.
if (!isComputeApps || result.status !== 0) {
  if (result.stdout) process.stdout.write(result.stdout)
  process.exit(result.status === null ? 1 : result.status)
}

const kept = []
for (const line of result.stdout.split(/\\r?\\n/)) {
  if (line.trim() === '') continue
  // The PID parse mirrors the coordinator exactly: first CSV field, safe positive integer. A row
  // that does not parse is unknown, and unknown is kept.
  const pid = Number(line.split(',')[0].trim())
  if (!Number.isSafeInteger(pid) || pid <= 0 || liveness(pid) !== 'dead') kept.push(line)
}
if (kept.length > 0) process.stdout.write(kept.join('\\n') + '\\n')
process.exit(0)
`

/**
 * Writes the liveness-filtering wrapper into `directory` and returns its executable path, ready
 * for `FileGpuLeaseCoordinator`'s `nvidiaSmiExecutable`. `innerExecutable` is the nvidia-smi the
 * wrapper delegates to — the real one by default, a fake in tests.
 */
export async function createLivenessFilteringNvidiaSmi(
  directory: string,
  innerExecutable = 'nvidia-smi',
): Promise<string> {
  const path = join(directory, 'liveness-filtering-nvidia-smi.cjs')
  await writeFile(
    path,
    WRAPPER_SOURCE.replace('INNER_EXECUTABLE_JSON', JSON.stringify(innerExecutable)),
    {
      mode: 0o700,
    },
  )
  return path
}
