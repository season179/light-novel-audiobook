import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileGpuLeaseCoordinator, type GpuLease } from '../src/index.js'

const roots: string[] = []
const children: ChildProcess[] = []
const holderGroups: number[] = []
/** Short enough to keep the suite quick, long enough to survive a loaded machine. */
const RELEASE_GRACE_MS = 500
/** Any release that outlives this is the unbounded wait the lease must never perform again. */
const RELEASE_DEADLINE_MS = 6_000

function coordinator(path: string): FileGpuLeaseCoordinator {
  return new FileGpuLeaseCoordinator({ lockFilePath: path, inspectExistingComputeProcesses: false })
}

async function makeRoot(name: string, base = tmpdir()): Promise<string> {
  const root = join(base, `${name}-${crypto.randomUUID()}`)
  roots.push(root)
  await mkdir(root, { recursive: true })
  return root
}

/**
 * The lock file's filesystem is what decides `flock` semantics, so only the lock lives on the
 * filesystem under test; helper scripts always stay on ext4 where the exec bit is unambiguous.
 */
interface LockFilesystem {
  readonly name: string
  readonly base: string | undefined
}

/** The deepest 9p/drvfs mount containing the repository, i.e. the Windows-hosted `/mnt/c` case. */
async function drvfsBase(): Promise<string | undefined> {
  const mounts = await readFile('/proc/mounts', 'utf8').catch(() => '')
  const cwd = process.cwd()
  let deepest: string | undefined
  for (const line of mounts.split('\n')) {
    const [, rawPoint, type] = line.split(' ')
    if (rawPoint === undefined || (type !== '9p' && type !== 'drvfs')) continue
    const point = rawPoint.replaceAll('\\040', ' ')
    if (cwd !== point && !cwd.startsWith(`${point}/`)) continue
    if (deepest === undefined || point.length > deepest.length) deepest = point
  }
  // `node_modules` is git-ignored and always present while the tests run.
  return deepest === undefined ? undefined : join(cwd, 'node_modules', '.cache')
}

const filesystems: readonly LockFilesystem[] = [
  { name: 'ext4', base: tmpdir() },
  { name: '9p-drvfs', base: await drvfsBase() },
]

/** Stands in for nvidia-smi, answering the compute-app and total-memory queries separately. */
async function fakeNvidiaSmi(
  root: string,
  output: { computeApps: string; memoryUsedMiB: string },
): Promise<string> {
  const path = join(root, 'fake-nvidia-smi')
  await writeFile(
    path,
    [
      '#!/bin/sh',
      'case "$1" in',
      `  --query-compute-apps=*) printf '%s' '${output.computeApps}' ;;`,
      `  --query-gpu=*) printf '%s' '${output.memoryUsedMiB}' ;;`,
      '  *) exit 2 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o700 },
  )
  return path
}

/**
 * Stands in for flock with a holder that survives stdin end and SIGTERM, so release must escalate
 * to SIGKILL. `$9` is the token the coordinator appends to the holder argv.
 */
async function fakeStubbornFlock(root: string, body: string): Promise<string> {
  const path = join(root, 'fake-flock')
  await writeFile(
    path,
    ['#!/bin/sh', body, "trap '' TERM", 'while true; do sleep 1; done', ''].join('\n'),
    {
      mode: 0o700,
    },
  )
  return path
}

/**
 * Reproduces the real two-process subtree - `flock` holding the descriptor open for a nested Node
 * process - but with a nested holder that ignores stdin EOF and SIGTERM. Only a process-group
 * SIGKILL can end this holder, which is exactly the wedged holder the release path must bound.
 */
async function wedgedHolderFlock(root: string): Promise<string> {
  const holder = join(root, 'wedged-holder.cjs')
  await writeFile(
    holder,
    [
      "process.stdout.write(process.argv[2] + '\\n')",
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
      `exec flock --exclusive --nonblock --conflict-exit-code 75 "$5" "$6" '${holder}' "$9"`,
      '',
    ].join('\n'),
    { mode: 0o700 },
  )
  return path
}

/** A live process inside this test's process tree, standing in for our own llama.cpp server. */
function spawnOwnedChild(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    stdio: 'ignore',
  })
  children.push(child)
  return child
}

/**
 * The direct `flock` child of this process for a given lock file. The nested holder is a child of
 * `flock`, never of this process, so matching on our own PID cannot pick it up by accident.
 */
async function directHolderPid(lockFilePath: string): Promise<number> {
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/u.test(entry)) continue
    const raw = await readFile(`/proc/${entry}/stat`, 'utf8').catch(() => undefined)
    if (raw === undefined) continue
    const fields = raw
      .slice(raw.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/u)
    if (Number(fields[1]) !== process.pid) continue
    const cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '')
    if (!cmdline.split('\0').includes(lockFilePath)) continue
    const pid = Number(entry)
    holderGroups.push(pid)
    return pid
  }
  throw new Error(`no direct holder process found for ${lockFilePath}`)
}

/**
 * A separate process that acquires a real lease through this coordinator and then blocks, so the
 * test can kill it outright. A detached holder must not outlive the caller that owns it.
 */
async function spawnLeaseHoldingCaller(lockFilePath: string): Promise<ChildProcess> {
  const caller = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        'const { FileGpuLeaseCoordinator } = await import(process.argv[2])',
        'const lease = await new FileGpuLeaseCoordinator({',
        '  lockFilePath: process.argv[1],',
        '  inspectExistingComputeProcesses: false,',
        "}).acquire('gemma')",
        "process.stdout.write('acquired\\n')",
        'setInterval(() => {}, 1_000)',
      ].join('\n'),
      lockFilePath,
      new URL('../src/index.ts', import.meta.url).href,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  children.push(caller)
  caller.stdout?.setEncoding('utf8')
  await new Promise<void>((resolveReady, rejectReady) => {
    caller.stdout?.on('data', (chunk: string) => {
      if (chunk.includes('acquired')) resolveReady()
    })
    caller.once('exit', (code) => rejectReady(new Error(`lease-holding caller exited: ${code}`)))
  })
  return caller
}

/**
 * Retries the non-blocking acquire until an unattended holder has actually released, with a real
 * deadline: nothing here is allowed to wait forever.
 */
async function acquireWithin(lockFilePath: string, ms: number): Promise<GpuLease> {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      return await coordinator(lockFilePath).acquire('qwen3-tts')
    } catch (error) {
      if (Date.now() >= deadline || (error as { code?: string }).code !== 'busy') throw error
      await new Promise((resolveRetry) => setTimeout(resolveRetry, 25))
    }
  }
}

function processGroupAlive(groupId: number): boolean {
  try {
    process.kill(-groupId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Rejects instead of hanging, so an unbounded release fails the test rather than the run. */
async function settleWithin<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ readonly value?: T; readonly error?: unknown; readonly elapsedMs: number }> {
  const started = Date.now()
  const settled = work.then(
    (value) => ({ value, elapsedMs: Date.now() - started }),
    (error: unknown) => ({ error, elapsedMs: Date.now() - started }),
  )
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      settled,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const groupId of holderGroups.splice(0)) {
    try {
      process.kill(-groupId, 'SIGKILL')
    } catch {
      // Already gone, which is the expected outcome of every test here.
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe.each(filesystems)('FileGpuLeaseCoordinator with the lock file on $name', ({ base }) => {
  const itFs = base === undefined ? it.skip : it

  itFs(
    'uses one kernel flock contract for Gemma and Qwen and releases without unlinking',
    async () => {
      const root = await makeRoot('gpu-flock', base)
      const path = join(root, 'exclusive.lock')
      const gemma = coordinator(path)
      const qwen = coordinator(path)

      const gemmaLease = await gemma.acquire('gemma')
      await expect(qwen.acquire('qwen3-tts')).rejects.toMatchObject({ code: 'busy' })
      expect((await stat(path)).isFile()).toBe(true)
      await gemmaLease.release()
      // Unlinking the lock file would break every waiter, so release must leave it in place.
      expect((await stat(path)).isFile()).toBe(true)

      const qwenLease = await qwen.acquire('qwen3-tts')
      expect(qwenLease.lockFilePath).toBe(path)
      await qwenLease.release()
      expect((await stat(path)).isFile()).toBe(true)
    },
  )

  itFs('releases gracefully when only the direct flock process was killed', async () => {
    const root = await makeRoot('gpu-flock-direct-kill', base)
    const path = join(root, 'exclusive.lock')
    const lease = await new FileGpuLeaseCoordinator({
      lockFilePath: path,
      inspectExistingComputeProcesses: false,
      releaseGraceMs: RELEASE_GRACE_MS,
    }).acquire('gemma')

    // The nested Node process, not this pid, is what holds the locked descriptor.
    const directPid = await directHolderPid(path)
    process.kill(directPid, 'SIGKILL')

    // Before the fix: the EOF was gated on the direct child being alive and the exit promise
    // settled on 'close', which a descendant holding the inherited pipes never lets arrive.
    const outcome = await settleWithin(lease.release(), RELEASE_DEADLINE_MS)
    expect(outcome.error).toBeUndefined()
    expect(processGroupAlive(directPid)).toBe(false)
    expect((await stat(path)).isFile()).toBe(true)

    const contender = await coordinator(path).acquire('qwen3-tts')
    await contender.release()
  })

  itFs('terminates the holder process group when the nested holder ignores stdin EOF', async () => {
    const scripts = await makeRoot('gpu-flock-wedged-scripts')
    const root = await makeRoot('gpu-flock-wedged', base)
    const path = join(root, 'exclusive.lock')
    const lease = await new FileGpuLeaseCoordinator({
      lockFilePath: path,
      flockExecutable: await wedgedHolderFlock(scripts),
      inspectExistingComputeProcesses: false,
      releaseGraceMs: RELEASE_GRACE_MS,
    }).acquire('gemma')
    const directPid = await directHolderPid(path)
    // The wedged nested holder really owns the kernel lock, not just the pipe.
    await expect(coordinator(path).acquire('qwen3-tts')).rejects.toMatchObject({ code: 'busy' })

    const outcome = await settleWithin(lease.release(), RELEASE_DEADLINE_MS)
    expect(outcome.error).toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('SIGKILL'),
    })
    expect(processGroupAlive(directPid)).toBe(false)
    expect((await stat(path)).isFile()).toBe(true)

    const contender = await coordinator(path).acquire('qwen3-tts')
    await contender.release()
  })

  itFs(
    'bounds release when the direct child is dead and a wedged descendant survives',
    async () => {
      const scripts = await makeRoot('gpu-flock-orphan-scripts')
      const root = await makeRoot('gpu-flock-orphan', base)
      const path = join(root, 'exclusive.lock')
      const lease = await new FileGpuLeaseCoordinator({
        lockFilePath: path,
        flockExecutable: await wedgedHolderFlock(scripts),
        inspectExistingComputeProcesses: false,
        releaseGraceMs: RELEASE_GRACE_MS,
      }).acquire('gemma')

      // The worst case from the issue: no direct child left to signal, and the descendant that
      // holds the descriptor ignores every EOF.
      const directPid = await directHolderPid(path)
      process.kill(directPid, 'SIGKILL')
      expect(processGroupAlive(directPid)).toBe(true)

      const outcome = await settleWithin(lease.release(), RELEASE_DEADLINE_MS)
      expect(outcome.error).toMatchObject({ code: 'unavailable' })
      expect(processGroupAlive(directPid)).toBe(false)
      expect((await stat(path)).isFile()).toBe(true)

      const contender = await coordinator(path).acquire('qwen3-tts')
      await contender.release()
    },
  )

  itFs(
    'releases at kernel level when the whole holder subtree dies, and still bounds release',
    async () => {
      const root = await makeRoot('gpu-flock-holder-death', base)
      const path = join(root, 'exclusive.lock')
      const lease = await new FileGpuLeaseCoordinator({
        lockFilePath: path,
        inspectExistingComputeProcesses: false,
        releaseGraceMs: RELEASE_GRACE_MS,
      }).acquire('gemma')
      const directPid = await directHolderPid(path)

      process.kill(-directPid, 'SIGKILL')
      const contender = await coordinator(path).acquire('qwen3-tts')
      await contender.release()
      expect((await stat(path)).isFile()).toBe(true)

      // A subtree that died on its own already released the lock, so release is a completed
      // release, not a failure - but it must still settle rather than wait on a dead child.
      const outcome = await settleWithin(lease.release(), RELEASE_DEADLINE_MS)
      expect(outcome.error).toBeUndefined()
    },
  )

  itFs('does not leave a detached holder behind when the caller process is killed', async () => {
    const root = await makeRoot('gpu-flock-caller-death', base)
    const path = join(root, 'exclusive.lock')
    const caller = await spawnLeaseHoldingCaller(path)
    await expect(coordinator(path).acquire('gemma')).rejects.toMatchObject({ code: 'busy' })

    // A detached holder lives in its own session, so nothing but its closed stdio pipe tells it
    // that the caller is gone. If that ever stops working, the GPU wedges for every process.
    caller.kill('SIGKILL')
    const contender = await acquireWithin(path, 5_000)
    await contender.release()
    expect((await stat(path)).isFile()).toBe(true)
  })
})

describe('FileGpuLeaseCoordinator', () => {
  it('treats nvidia-smi as a post-lock diagnostic and releases after a diagnostic failure', async () => {
    const root = await makeRoot('gpu-flock-diagnostic')
    const path = join(root, 'exclusive.lock')
    const diagnostic = new FileGpuLeaseCoordinator({
      lockFilePath: path,
      nvidiaSmiExecutable: '/bin/echo',
    })

    await expect(diagnostic.acquire('qwen3-tts')).rejects.toMatchObject({ code: 'diagnostic' })
    const lease = await coordinator(path).acquire('composition')
    await lease.release()
  })

  it('cancels acquisition while another process owns the kernel lease', async () => {
    const root = await makeRoot('gpu-flock-cancel')
    const path = join(root, 'exclusive.lock')
    const first = await coordinator(path).acquire('gemma')
    const controller = new AbortController()
    controller.abort()

    await expect(coordinator(path).acquire('qwen3-tts', controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    })
    await first.release()
  })

  it('runs the production default inspection and excludes this process tree by PID', async () => {
    const root = await makeRoot('gpu-flock-self')
    const path = join(root, 'exclusive.lock')
    const owned = spawnOwnedChild()
    // Exactly what WSL2/GPU-PV reports: a real PID with an unusable name and per-process memory.
    const nvidiaSmiExecutable = await fakeNvidiaSmi(root, {
      computeApps: `${owned.pid}, [Not Found], [N/A]`,
      memoryUsedMiB: '14400',
    })

    const lease = await new FileGpuLeaseCoordinator({
      lockFilePath: path,
      nvidiaSmiExecutable,
    }).acquire('gemma')
    expect(lease.lockFilePath).toBe(path)
    await lease.release()
  })

  it('rejects a foreign compute process under the production default and frees the lock', async () => {
    const root = await makeRoot('gpu-flock-foreign')
    const path = join(root, 'exclusive.lock')
    const nvidiaSmiExecutable = await fakeNvidiaSmi(root, {
      computeApps: '1, [Not Found], [N/A]',
      memoryUsedMiB: '231',
    })

    await expect(
      new FileGpuLeaseCoordinator({ lockFilePath: path, nvidiaSmiExecutable }).acquire('gemma'),
    ).rejects.toMatchObject({ code: 'diagnostic' })
    const lease = await coordinator(path).acquire('qwen3-tts')
    await lease.release()
  })

  it('rejects unattributed GPU residency above the threshold and allows the idle baseline', async () => {
    const root = await makeRoot('gpu-flock-residency')
    const path = join(root, 'exclusive.lock')
    const loaded = await fakeNvidiaSmi(root, { computeApps: '', memoryUsedMiB: '2007' })
    await expect(
      new FileGpuLeaseCoordinator({
        lockFilePath: path,
        nvidiaSmiExecutable: loaded,
      }).acquire('gemma'),
    ).rejects.toMatchObject({ code: 'diagnostic' })

    const idleRoot = await makeRoot('gpu-flock-residency-idle')
    const idle = await fakeNvidiaSmi(idleRoot, { computeApps: '', memoryUsedMiB: '231' })
    const lease = await new FileGpuLeaseCoordinator({
      lockFilePath: path,
      nvidiaSmiExecutable: idle,
    }).acquire('gemma')
    await lease.release()
  })

  it('reports the diagnostic cause even when stopping the holder needs SIGKILL', async () => {
    const root = await makeRoot('gpu-flock-cause')
    const path = join(root, 'exclusive.lock')
    const flockExecutable = await fakeStubbornFlock(root, `printf '%s\\n' "$9"`)
    const nvidiaSmiExecutable = await fakeNvidiaSmi(root, {
      computeApps: '1, [Not Found], [N/A]',
      memoryUsedMiB: '231',
    })

    await expect(
      new FileGpuLeaseCoordinator({
        lockFilePath: path,
        flockExecutable,
        nvidiaSmiExecutable,
        releaseGraceMs: 200,
      }).acquire('gemma'),
    ).rejects.toMatchObject({
      code: 'diagnostic',
      message: expect.stringContaining('Uncoordinated GPU compute process'),
    })
  })

  it('stops a holder whose handshake is unusable instead of waiting on a live process', async () => {
    const root = await makeRoot('gpu-flock-unusable')
    const path = join(root, 'exclusive.lock')
    const flockExecutable = await fakeStubbornFlock(
      root,
      // Comfortably past the 4 KB handshake ceiling without ever printing the token.
      'i=0; while [ $i -lt 400 ]; do printf "not-the-token-%s\\n" "$i"; i=$((i+1)); done',
    )

    await expect(
      new FileGpuLeaseCoordinator({
        lockFilePath: path,
        flockExecutable,
        inspectExistingComputeProcesses: false,
        releaseGraceMs: 200,
      }).acquire('gemma'),
    ).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('unusable handshake'),
    })
  }, 10_000)

  it('never treats an unreadable memory reading as zero usage', async () => {
    const root = await makeRoot('gpu-flock-unknown-memory')
    const path = join(root, 'exclusive.lock')
    const nvidiaSmiExecutable = await fakeNvidiaSmi(root, {
      computeApps: '',
      memoryUsedMiB: '[N/A]',
    })

    const lease = await new FileGpuLeaseCoordinator({
      lockFilePath: path,
      nvidiaSmiExecutable,
      residentGpuMemoryThresholdMiB: 512,
    }).acquire('gemma')
    await lease.release()
  })
})
