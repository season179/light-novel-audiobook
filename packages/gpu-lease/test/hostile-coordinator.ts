// The only way to obtain a wedged-flock coordinator: a deliberately hostile holder subtree
// (stdin-EOF-immune, SIGTERM/SIGHUP-immune) with registration inseparable from construction.
//
// Ordering, not convention, is what closes the #67 registration window. The nested holder is
// written BENIGN: like the production holder it exits on stdin EOF and keeps default signal
// dispositions. It arms its EOF/SIGTERM/SIGHUP immunity - and only then prints its handshake
// token - after a gate file appears, and that gate is written by this helper strictly after
// `registerHolder` has durably published the registry entry (fsync + rename + parent-dir fsync).
// So at every instant:
//
//   - before the durable entry exists, the holder is benign: an interrupt EOFs it through the
//     worker's closed pipe and nothing survives;
//   - once the holder is hostile, the entry already exists and a later startup reaps it.
//
// There is no instant at which a hostile holder exists and is not yet reapable, and because the
// token is printed only after arming, a completed handshake is itself proof of registration.
//
// A guard test asserts no `wedgedHolderFlock` reference exists outside this file.

import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { FileGpuLeaseCoordinator } from '../src/index.js'
import { registerHolder } from './fixture-reaper.js'

/** Name of the arming gate inside the scripts root; its existence makes the holder hostile. */
const HOSTILE_GATE_NAME = 'go-hostile'

/**
 * Reproduces the real two-process subtree - `flock` holding the descriptor open for a nested Node
 * process - where the nested holder starts benign and becomes EOF/SIGTERM/SIGHUP-immune only once
 * `hostileGatePath` exists (see the file header for why this ordering is load-bearing). Only a
 * process-group SIGKILL can end the armed holder, which is exactly the wedged holder the release
 * path must bound.
 *
 * With `tokenGatePath`, the holder additionally waits for that file before arming, so an outer
 * test can hold `acquire()` in flight at a precise point.
 */
async function wedgedHolderFlock(
  root: string,
  tokenGatePath: string | undefined,
  hostileGatePath: string,
): Promise<string> {
  const holder = join(root, 'wedged-holder.cjs')
  await writeFile(
    holder,
    [
      'const tokenGate = process.argv[3]',
      'const hostileGate = process.argv[4]',
      "const { existsSync } = require('node:fs')",
      'const benignExit = () => process.exit(0)',
      'process.stdin.resume()',
      '// Benign until the registration gate exists: stdin EOF ends us exactly like the',
      '// production holder, so an interrupt before registration leaves nothing behind.',
      "process.stdin.on('end', benignExit)",
      'const waitFor = (path, done) => {',
      '  const poll = setInterval(() => {',
      '    if (existsSync(path)) {',
      '      clearInterval(poll)',
      '      done()',
      '    }',
      '  }, 2)',
      '}',
      'const armAndPrintToken = () => {',
      "  process.stdin.removeListener('end', benignExit)",
      "  process.on('SIGTERM', () => {})",
      "  process.on('SIGHUP', () => {})",
      "  process.stdout.write(process.argv[2] + '\\n')",
      '}',
      'const start = () => waitFor(hostileGate, armAndPrintToken)',
      'if (!tokenGate) start()',
      'else waitFor(tokenGate, start)',
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
        tokenGatePath === undefined ? " ''" : ` '${tokenGatePath}'`
      } '${hostileGatePath}'`,
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
   * When set, the holder waits for this file before arming and printing its handshake token (in
   * addition to the always-required arming gate), letting a probe choose the exact moment
   * acquisition may proceed.
   */
  readonly gatePath?: string
  /** Observer hook invoked after the holder group exists and before registration begins. */
  readonly beforeRegister?: (holderPgid: number) => Promise<void>
  /** Observer hook invoked after durable registration has completed and the holder is armed. */
  readonly afterRegister?: (holderPgid: number) => Promise<void>
}

/**
 * A wedged-flock coordinator that always registers its holder group in the durable fixture
 * registry and arms the holder's hostility only after that entry exists. Registration is not
 * optional here: it is what makes a deliberately unkillable holder reaped after an interrupted
 * run.
 */
export async function hostileCoordinator(
  config: HostileCoordinatorConfig,
): Promise<FileGpuLeaseCoordinator> {
  const hostileGatePath = join(config.scriptsRoot, HOSTILE_GATE_NAME)
  return new FileGpuLeaseCoordinator({
    lockFilePath: config.lockFilePath,
    flockExecutable: await wedgedHolderFlock(config.scriptsRoot, config.gatePath, hostileGatePath),
    inspectExistingComputeProcesses: false,
    ...(config.releaseGraceMs === undefined ? {} : { releaseGraceMs: config.releaseGraceMs }),
    onHolderStarted: async (holderPgid) => {
      await config.beforeRegister?.(holderPgid)
      await registerHolder(holderPgid, dirname(config.lockFilePath))
      // Arming is strictly after the durable publication above, so the holder can never be
      // hostile while unreapable. See the file header.
      await writeFile(hostileGatePath, '', 'utf8')
      await config.afterRegister?.(holderPgid)
    },
  })
}
