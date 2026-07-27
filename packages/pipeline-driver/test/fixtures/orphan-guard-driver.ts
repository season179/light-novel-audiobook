import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRealTransports } from '../../src/transports.js'

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

const root = required('LNA_ORPHAN_FIXTURE_ROOT')
const probeDirectory = required('LNA_ORPHAN_FIXTURE_PROBE')
const scenario = required('LNA_ORPHAN_FIXTURE_SCENARIO')
const port = Number(required('LNA_ORPHAN_FIXTURE_PORT'))
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
  throw new Error('invalid fixture port')

const transports = await createRealTransports({
  directorBaseUrl: `http://127.0.0.1:${port}/v1`,
  llamaRuntimeRoot: root,
  pythonExecutable: process.execPath,
  workerScriptPath: path.join(root, 'unused-worker.py'),
  runtimeManifestPath: path.join(root, 'unused-manifest.json'),
  modelSnapshotPath: path.join(root, 'qwen-snapshot'),
  gpuLockFilePath: path.join(root, 'gpu.lock'),
  directorCaptureDirectory: path.join(root, 'diagnostics'),
  startupTimeoutMs: 5_000,
})

const boundedHoldForParent = async (purpose: string): Promise<never> => {
  const deadline = performance.now() + 15_000
  while (performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${purpose} was not triggered within the fixture's 15000ms bound`)
}

const finishPath = path.join(probeDirectory, 'finish')
const waitForFinish = async (): Promise<void> => {
  const deadline = performance.now() + 10_000
  while (performance.now() < deadline) {
    if ((await readFile(finishPath).catch(() => undefined)) !== undefined) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('host-listener fixture did not receive its bounded finish gate')
}

if (scenario === 'host-sigint' || scenario === 'host-sigterm') {
  const signal = scenario === 'host-sigint' ? 'SIGINT' : 'SIGTERM'
  process.on(signal, () => {
    void writeFile(
      path.join(probeDirectory, 'host-listener.json'),
      `${JSON.stringify({ driverPid: process.pid, signal })}\n`,
      { flag: 'wx' },
    )
  })
}

const runtime = transports.director.createRuntime()
await runtime.lifecycle.start()
const serverPid = Number(
  await readFile(path.join(root, `.pipeline-driver-key-${process.pid}-1.pid`), 'utf8'),
)
await writeFile(
  path.join(probeDirectory, 'ready.json'),
  `${JSON.stringify({ driverPid: process.pid, serverPid, port })}\n`,
  { flag: 'wx' },
)

if (scenario === 'exit') {
  process.exit(0)
} else if (scenario === 'unhandled-rejection') {
  void Promise.reject(new Error('intentional orphan-guard fixture rejection'))
  await boundedHoldForParent('unhandled rejection termination')
} else if (scenario === 'sigterm') {
  await boundedHoldForParent('driver-only SIGTERM')
} else if (scenario === 'clean-release') {
  await runtime.lifecycle.release()
  await transports.close()
  await writeFile(path.join(probeDirectory, 'clean-release'), 'released\n', { flag: 'wx' })
} else if (scenario === 'host-sigint' || scenario === 'host-sigterm') {
  await waitForFinish()
  await transports.close()
} else {
  throw new Error(`unknown orphan-guard fixture scenario: ${scenario}`)
}
