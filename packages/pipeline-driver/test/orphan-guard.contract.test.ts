import { type ChildProcess, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SELECTED_GEMMA_PROFILE } from '@light-novel-audiobook/gemma-director'
import { afterEach, describe, expect, it } from 'vitest'

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const FIXTURE = path.join(
  REPOSITORY_ROOT,
  'packages/pipeline-driver/test/fixtures/orphan-guard-driver.ts',
)

interface Probe {
  readonly child: ChildProcess
  readonly root: string
  readonly probeDirectory: string
  readonly port: number
  readonly output: () => string
}

interface ReadyReceipt {
  readonly driverPid: number
  readonly serverPid: number
  readonly port: number
}

const probes: Probe[] = []
const reservations: Server[] = []

const processRunning = async (pid: number): Promise<boolean> => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    return stat.split(' ')[2] !== 'Z'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Linux may report ESRCH when the task vanishes between opening and reading procfs. Hosted CI
    // run 30221208089 threw here for a probe that was already gone, so the predicate has to treat
    // both disappearance codes as dead — rethrowing turns a correct observation into a failure.
    if (code === 'ENOENT' || code === 'ESRCH') return false
    throw error
  }
}

const delay = async (ms: number): Promise<void> =>
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms))

const reservePort = async (): Promise<{ readonly port: number; release(): Promise<void> }> => {
  const server = createServer()
  reservations.push(server)
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('port reservation failed')
  return {
    port: address.port,
    release: async () => {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
      )
      reservations.splice(reservations.indexOf(server), 1)
    },
  }
}

const waitForFile = async (
  candidate: string,
  timeoutMs: number,
  purpose: string,
): Promise<string> => {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const value = await readFile(candidate, 'utf8').catch(() => undefined)
    if (value !== undefined) return value
    await delay(20)
  }
  throw new Error(`${purpose} did not publish ${candidate} within ${timeoutMs}ms`)
}

const waitForExit = async (
  probe: Probe,
  timeoutMs: number,
  purpose: string,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> => {
  if (probe.child.exitCode !== null || probe.child.signalCode !== null) {
    return { code: probe.child.exitCode, signal: probe.child.signalCode }
  }
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (probe.child.exitCode !== null || probe.child.signalCode !== null) {
      return { code: probe.child.exitCode, signal: probe.child.signalCode }
    }
    await delay(20)
  }
  throw new Error(`${purpose} did not exit within ${timeoutMs}ms; output=${probe.output()}`)
}

const canConnect = async (port: number): Promise<boolean> =>
  await new Promise<boolean>((resolveConnection) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolveConnection(true)
    })
    socket.once('error', () => resolveConnection(false))
  })

const waitForPortBound = async (port: number, timeoutMs: number): Promise<void> => {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (await canConnect(port)) return
    await delay(20)
  }
  throw new Error(`owned fake server did not bind reserved port ${port} within ${timeoutMs}ms`)
}

const portCanBeReserved = async (port: number): Promise<boolean> => {
  const server = createServer()
  return await new Promise<boolean>((resolveReservation) => {
    server.once('error', () => resolveReservation(false))
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => resolveReservation(error === undefined))
    })
  })
}

const waitForPortFree = async (port: number, timeoutMs: number, purpose: string): Promise<void> => {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (await portCanBeReserved(port)) return
    await delay(20)
  }
  throw new Error(`${purpose} left port ${port} bound after ${timeoutMs}ms`)
}

const waitForProcessGone = async (
  pid: number,
  timeoutMs: number,
  purpose: string,
): Promise<void> => {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (!(await processRunning(pid))) return
    await delay(20)
  }
  throw new Error(`${purpose} left process ${pid} alive after ${timeoutMs}ms`)
}

const buildProbe = async (scenario: string): Promise<Probe> => {
  const root = await mkdtemp(path.join(tmpdir(), 'lna-orphan-guard-'))
  const probeDirectory = path.join(root, 'probe')
  const binaryPath = path.join(root, 'llama.cpp/build/bin/llama-server')
  await Promise.all([
    mkdir(path.dirname(binaryPath), { recursive: true }),
    mkdir(path.join(root, 'models'), { recursive: true }),
    mkdir(path.join(root, 'qwen-snapshot'), { recursive: true }),
    mkdir(probeDirectory, { recursive: true }),
  ])
  await writeFile(
    binaryPath,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
const port = Number(value('--port'))
const keyPath = value('--api-key-file')
writeFileSync(keyPath + '.pid', String(process.pid))
const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"status":"ok"}')
    return
  }
  response.writeHead(404)
  response.end()
})
server.listen(port, '127.0.0.1')
`,
  )
  await chmod(binaryPath, 0o755)
  await writeFile(path.join(root, 'models', SELECTED_GEMMA_PROFILE.file), '')

  const reservation = await reservePort()
  await reservation.release()
  const child = spawn(
    process.execPath,
    ['--unhandled-rejections=strict', '--import', 'tsx', FIXTURE],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        LNA_ORPHAN_FIXTURE_ROOT: root,
        LNA_ORPHAN_FIXTURE_PROBE: probeDirectory,
        LNA_ORPHAN_FIXTURE_SCENARIO: scenario,
        LNA_ORPHAN_FIXTURE_PORT: String(reservation.port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  const append = (chunk: unknown): void => {
    output = `${output}${String(chunk)}`.slice(-8_000)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  const probe = { child, root, probeDirectory, port: reservation.port, output: () => output }
  probes.push(probe)
  return probe
}

const readyProbe = async (
  scenario: string,
  expectStillRunning = true,
): Promise<{ probe: Probe; receipt: ReadyReceipt }> => {
  const probe = await buildProbe(scenario)
  const receipt = JSON.parse(
    await waitForFile(path.join(probe.probeDirectory, 'ready.json'), 15_000, `${scenario} startup`),
  ) as ReadyReceipt
  expect(receipt.driverPid).toBe(probe.child.pid)
  expect(receipt.port).toBe(probe.port)
  if (expectStillRunning) {
    expect(await processRunning(receipt.serverPid)).toBe(true)
    await waitForPortBound(probe.port, 5_000)
  }
  return { probe, receipt }
}

const expectRuntimeGone = async (
  probe: Probe,
  receipt: ReadyReceipt,
  purpose: string,
): Promise<void> => {
  await waitForProcessGone(receipt.serverPid, 5_000, purpose)
  await waitForPortFree(probe.port, 5_000, purpose)
  expect(await processRunning(receipt.serverPid)).toBe(false)
}

afterEach(async () => {
  for (const reservation of reservations.splice(0)) {
    await new Promise<void>((resolveClose) => reservation.close(() => resolveClose()))
  }
  for (const probe of probes.splice(0)) {
    const driverPid = probe.child.pid
    if (driverPid !== undefined && (await processRunning(driverPid))) {
      try {
        process.kill(driverPid, 'SIGKILL')
      } catch {
        // Already gone.
      }
      await waitForProcessGone(driverPid, 5_000, 'driver cleanup')
    }
    const rawReceipt = await readFile(path.join(probe.probeDirectory, 'ready.json'), 'utf8').catch(
      () => undefined,
    )
    if (rawReceipt !== undefined) {
      const receipt = JSON.parse(rawReceipt) as ReadyReceipt
      if (await processRunning(receipt.serverPid)) {
        try {
          process.kill(receipt.serverPid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
      await waitForProcessGone(receipt.serverPid, 5_000, 'server cleanup')
    }
    await waitForPortFree(probe.port, 5_000, 'port cleanup')
    await rm(probe.root, { recursive: true, force: true })
  }
})

describe.sequential('real transport process orphan guards', () => {
  it('reaps the owned server when the driver exits without release', async () => {
    const { probe, receipt } = await readyProbe('exit', false)

    expect(await waitForExit(probe, 5_000, 'ordinary driver exit')).toEqual({
      code: 0,
      signal: null,
    })
    await expectRuntimeGone(probe, receipt, 'ordinary driver exit')
  })

  it('reaps the owned server after an unhandled rejection terminates the driver', async () => {
    const { probe, receipt } = await readyProbe('unhandled-rejection', false)

    const exited = await waitForExit(probe, 5_000, 'unhandled-rejection driver exit')
    expect(exited.code).not.toBe(0)
    await expectRuntimeGone(probe, receipt, 'unhandled-rejection driver exit')
  })

  it('reaps before relaying SIGTERM aimed only at the driver pid', async () => {
    const { probe, receipt } = await readyProbe('sigterm')
    if (probe.child.pid === undefined) throw new Error('SIGTERM probe has no driver pid')

    process.kill(probe.child.pid, 'SIGTERM')

    expect(await waitForExit(probe, 5_000, 'driver-only SIGTERM')).toEqual({
      code: null,
      signal: 'SIGTERM',
    })
    await expectRuntimeGone(probe, receipt, 'driver-only SIGTERM')
  })

  it('preserves clean explicit release and transport close', async () => {
    const { probe, receipt } = await readyProbe('clean-release', false)

    expect(await waitForExit(probe, 5_000, 'clean release')).toEqual({ code: 0, signal: null })
    await waitForFile(path.join(probe.probeDirectory, 'clean-release'), 1_000, 'clean release')
    await expectRuntimeGone(probe, receipt, 'clean release')
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`defers ${signal} relay when the host has its own listener`, async () => {
      const scenario = signal === 'SIGINT' ? 'host-sigint' : 'host-sigterm'
      const { probe, receipt } = await readyProbe(scenario)
      if (probe.child.pid === undefined) throw new Error(`${signal} probe has no driver pid`)

      process.kill(probe.child.pid, signal)

      const hostReceipt = JSON.parse(
        await waitForFile(
          path.join(probe.probeDirectory, 'host-listener.json'),
          2_000,
          `${signal} host listener`,
        ),
      ) as { readonly driverPid: number; readonly signal: string }
      expect(hostReceipt).toEqual({ driverPid: probe.child.pid, signal })
      await expectRuntimeGone(probe, receipt, `${signal} host-owned shutdown`)
      await delay(200)
      expect(await processRunning(probe.child.pid)).toBe(true)
      expect(probe.child.exitCode).toBeNull()
      expect(probe.child.signalCode).toBeNull()

      await writeFile(path.join(probe.probeDirectory, 'finish'), 'finish\n', { flag: 'wx' })
      expect(await waitForExit(probe, 5_000, `${signal} host-owned finish`)).toEqual({
        code: 0,
        signal: null,
      })
    })
  }
})
