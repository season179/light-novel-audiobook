// The only way to obtain a wedged-flock coordinator: a deliberately hostile holder subtree
// (stdin-EOF-immune, SIGTERM/SIGHUP-immune) with registration inseparable from construction.
//
// Only these hostile sites need the `onHolderStarted` registration observer: their holders
// survive every polite stop, so an interrupted run can only be cleaned up through the durable
// registry. Keeping hostility and registration in one helper is what stops a future edit from
// dropping the observer at one site and silently restoring the #67 regression with a green
// suite. A guard test asserts no `wedgedHolderFlock` reference exists outside this file.

import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { FileGpuLeaseCoordinator } from '../src/index.js'
import { registerHolder } from './fixture-reaper.js'

/**
 * Reproduces the real two-process subtree - `flock` holding the descriptor open for a nested Node
 * process - but with a nested holder that ignores stdin EOF and SIGTERM. Only a process-group
 * SIGKILL can end this holder, which is exactly the wedged holder the release path must bound.
 *
 * With `gatePath`, the nested holder waits for that file to exist before printing its handshake
 * token, so an outer test can hold `acquire()` in flight at a precise point.
 */
async function wedgedHolderFlock(root: string, gatePath?: string): Promise<string> {
  const holder = join(root, 'wedged-holder.cjs')
  await writeFile(
    holder,
    [
      'const gate = process.argv[3]',
      'const printToken = () => process.stdout.write(process.argv[2] + \'\\n\')',
      'if (gate === undefined) {',
      '  printToken()',
      '} else {',
      "  const { existsSync } = require('node:fs')",
      '  const gatePoll = setInterval(() => {',
      '    if (existsSync(gate)) {',
      '      clearInterval(gatePoll)',
      '      printToken()',
      '    }',
      '  }, 2)',
      '}',
      'process.stdin.resume()',
      "process.on('SIGTERM', () => {})",
      "process.on('SIGHUP', () => {})",
      'setInterval(() => {}, 1_000)',
      '',
    ].join('\n'),
    { mode: 0o600 },
  )
  const path = join(root, 'wedged-flock')
  await writeFile(
    path,
    [
      '#!/bin/sh',
      '# $5 is the lock file, $6 the node executable, $9 the handshake token.',
      `exec flock --exclusive --nonblock --conflict-exit-code 75 "$5" "$6" '${holder}' "$9"${
        gatePath === undefined ? '' : ` '${gatePath}'`
      }`,
      '',
    ].join('\n'),
    { mode: 0o700 },
  )
  return path
}

export interface HostileCoordinatorConfig {
  readonly lockFilePath: string
  /** Directory the wedged-flock scripts are written into; must already exist. */
  readonly scriptsRoot: string
  readonly releaseGraceMs?: number
  /**
   * When set, the nested holder prints its handshake token only after this file appears, letting a
   * probe choose the exact moment acquisition may proceed.
   */
  readonly gatePath?: string
  /** Observer hook invoked after the holder group exists and before registration begins. */
  readonly beforeRegister?: (holderPgid: number) => Promise<void>
  /** Observer hook invoked after durable registration has completed. */
  readonly afterRegister?: (holderPgid: number) => Promise<void>
}

/**
 * A wedged-flock coordinator that always registers its holder group in the durable fixture
 * registry before acquisition can settle. Registration is not optional here: it is what makes a
 * deliberately unkillable holder reaped after an interrupted run.
 */
export async function hostileCoordinator(
  config: HostileCoordinatorConfig,
): Promise<FileGpuLeaseCoordinator> {
  return new FileGpuLeaseCoordinator({
    lockFilePath: config.lockFilePath,
    flockExecutable: await wedgedHolderFlock(config.scriptsRoot, config.gatePath),
    inspectExistingComputeProcesses: false,
    ...(config.releaseGraceMs === undefined ? {} : { releaseGraceMs: config.releaseGraceMs }),
    onHolderStarted: async (holderPgid) => {
      await config.beforeRegister?.(holderPgid)
      await registerHolder(holderPgid, dirname(config.lockFilePath))
      await config.afterRegister?.(holderPgid)
    },
  })
}
