import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SELECTED_GEMMA_PROFILE } from '@light-novel-audiobook/gemma-director'
import { afterEach, describe, expect, it } from 'vitest'
import type { PipelineTransports } from '../src/transports.js'
import { createRealTransports } from '../src/transports.js'

const roots: string[] = []
const transportsToClose: PipelineTransports[] = []

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const freePort = async (): Promise<number> =>
  await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('free-port probe did not receive an IP address'))
        return
      }
      probe.close((error) => (error === undefined ? resolve(address.port) : reject(error)))
    })
  })

const buildTransports = async (): Promise<{
  readonly transports: PipelineTransports
  readonly root: string
  readonly modePath: string
}> => {
  const root = await mkdtemp(path.join(tmpdir(), 'lna-per-run-lifecycle-'))
  roots.push(root)
  const binaryPath = path.join(root, 'llama.cpp/build/bin/llama-server')
  const modePath = path.join(root, 'stub-mode')
  await mkdir(path.dirname(binaryPath), { recursive: true })
  await writeFile(
    binaryPath,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
const port = Number(value('--port'))
const keyPath = value('--api-key-file')
writeFileSync(keyPath + '.pid', String(process.pid))
if (readFileSync(path.join(${JSON.stringify(root)}, 'stub-mode'), 'utf8').trim() === 'fail') process.exit(9)
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
  await mkdir(path.join(root, 'models'), { recursive: true })
  await writeFile(path.join(root, 'models', SELECTED_GEMMA_PROFILE.file), '')
  const modelSnapshotPath = path.join(root, 'qwen-snapshot')
  await mkdir(modelSnapshotPath)
  await writeFile(modePath, 'healthy\n')

  const transports = await createRealTransports({
    directorBaseUrl: `http://127.0.0.1:${await freePort()}/v1`,
    llamaRuntimeRoot: root,
    pythonExecutable: process.execPath,
    workerScriptPath: path.join(root, 'unused-worker.py'),
    runtimeManifestPath: path.join(root, 'unused-manifest.json'),
    modelSnapshotPath,
    gpuLockFilePath: path.join(root, 'gpu.lock'),
    directorCaptureDirectory: path.join(root, 'diagnostics'),
    startupTimeoutMs: 2_000,
  })
  transportsToClose.push(transports)
  return { transports, root, modePath }
}

const pidReceipt = async (root: string, sequence: number): Promise<number> =>
  Number(
    await readFile(path.join(root, `.pipeline-driver-key-${process.pid}-${sequence}.pid`), 'utf8'),
  )

const expectNoRuntimeKeys = async (root: string): Promise<void> => {
  expect(
    (await readdir(root)).filter(
      (entry) => entry.startsWith('.pipeline-driver-key-') && !entry.endsWith('.pid'),
    ),
  ).toEqual([])
}

afterEach(async () => {
  await Promise.allSettled(transportsToClose.splice(0).map((transports) => transports.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('real transport per-run director lifecycle factory', () => {
  it('starts three distinct single-use runtime instances sequentially', async () => {
    const { transports, root } = await buildTransports()
    const runtimes = [
      transports.director.createRuntime(),
      transports.director.createRuntime(),
      transports.director.createRuntime(),
    ]

    expect(new Set(runtimes.map((runtime) => runtime.lifecycle)).size).toBe(3)
    expect(new Set(runtimes.map((runtime) => runtime.apiKey)).size).toBe(3)

    const pids: number[] = []
    for (const [index, runtime] of runtimes.entries()) {
      await runtime.lifecycle.start()
      const pid = await pidReceipt(root, index + 1)
      pids.push(pid)
      expect(processAlive(pid)).toBe(true)
      // The predecessor was observed dead before this start could become healthy on the same port.
      if (index > 0) expect(processAlive(pids[index - 1] as number)).toBe(false)
      await runtime.lifecycle.release()
      expect(processAlive(pid)).toBe(false)
    }

    expect(new Set(pids).size).toBe(3)
    expect(transports.lifecycleEvents).toEqual([
      `director:start:pid=${pids[0]}`,
      'director:release:process-exited',
      `director:start:pid=${pids[1]}`,
      'director:release:process-exited',
      `director:start:pid=${pids[2]}`,
      'director:release:process-exited',
    ])
    const captureNames = (await readdir(path.join(root, 'diagnostics'))).sort()
    expect(captureNames).toHaveLength(3)
    expect(new Set(captureNames).size).toBe(3)
    for (const captureName of captureNames) {
      const capture = await readFile(path.join(root, 'diagnostics', captureName), 'utf8')
      expect(capture).toContain('phase=healthy')
      expect(capture).toContain('phase=exited')
    }
    await expectNoRuntimeKeys(root)
  })

  it('releases a failed start without leaving a child or key resident', async () => {
    const { transports, root, modePath } = await buildTransports()
    await writeFile(modePath, 'fail\n')
    const runtime = transports.director.createRuntime()

    await expect(runtime.lifecycle.start()).rejects.toThrow('exited during model load')
    const pid = await pidReceipt(root, 1)
    expect(processAlive(pid)).toBe(false)
    await runtime.lifecycle.release()

    expect(processAlive(pid)).toBe(false)
    expect(transports.lifecycleEvents).toEqual(['director:release:process-exited'])
    await expectNoRuntimeKeys(root)
  })

  it('keeps the process orphan guard as a close-time safety net', async () => {
    const before = {
      exit: process.listenerCount('exit'),
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    }
    const { transports, root } = await buildTransports()
    const runtime = transports.director.createRuntime()
    await runtime.lifecycle.start()
    const pid = await pidReceipt(root, 1)
    expect(processAlive(pid)).toBe(true)

    await transports.close()

    expect(processAlive(pid)).toBe(false)
    await expectNoRuntimeKeys(root)
    expect(process.listenerCount('exit')).toBe(before.exit)
    expect(process.listenerCount('SIGINT')).toBe(before.sigint)
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm)
    expect(() => transports.director.createRuntime()).toThrow('have been closed')
  })
})
