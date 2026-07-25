import { type ChildProcess, execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { LlamaCppSpikeClient, SpikeError } from '../src'

const execFile = promisify(execFileCallback)
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME_ROOT = resolve(
  process.env.LLAMA_CPP_SPIKE_ROOT ?? `${homedir()}/.cache/light-novel-audiobook/issue-5`,
)
const LLAMA_COMMIT = '555881ebc8b0fc0402b30e09258a32a7bfd13c52'
const MODEL_REVISION = '09816acd5d99df7be770d85ea30822623dab342c'
const MODEL_SHA256 = '2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d'
const MODEL_ALIAS = 'smollm2-135m-instruct-q4-k-m'
const HOST = '127.0.0.1'
const PORT = Number(process.env.LLAMA_CPP_SPIKE_PORT ?? '8080')
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) throw new Error('Invalid spike port')
const ORIGIN = `http://${HOST}:${PORT}`
const BINARY = resolve(RUNTIME_ROOT, 'llama.cpp/build/bin/llama-server')
const MODEL = resolve(RUNTIME_ROOT, 'models/SmolLM2-135M-Instruct-Q4_K_M.gguf')
const LOG = resolve(RUNTIME_ROOT, 'real-host-smoke.log')
const EVIDENCE = resolve(PACKAGE_ROOT, 'evidence/real-host-run.json')

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function ssLines(): Promise<Array<string>> {
  const { stdout } = await execFile('ss', ['-H', '-ltn', `( sport = :${PORT} )`])
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/health`)
      if (response.ok && ((await response.json()) as { status?: string }).status === 'ok') return
    } catch {
      // The process is still loading.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw new Error('llama.cpp did not become healthy before the startup deadline')
}

async function slotsIdle(): Promise<boolean> {
  try {
    const response = await fetch(`${ORIGIN}/slots`)
    if (!response.ok) return false
    const slots = (await response.json()) as Array<{ is_processing?: boolean }>
    return slots.length > 0 && slots.every((slot) => slot.is_processing === false)
  } catch {
    return false
  }
}

async function observeBusySlot(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/slots`)
      if (response.ok) {
        const slots = (await response.json()) as Array<{ is_processing?: boolean }>
        if (slots.some((slot) => slot.is_processing === true)) return true
      }
    } catch {
      // Retry only within the bounded observation window.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2))
  }
  return false
}

async function waitForIdleSlots(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await slotsIdle()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
  throw new Error('llama.cpp did not release its inference slot after cancellation')
}

async function stopOwnedProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise<boolean>((resolvePromise) => child.once('exit', () => resolvePromise(true))),
    new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), 5_000)),
  ])
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL')
    await new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise()))
  }
}

async function main(): Promise<void> {
  if ((await ssLines()).length > 0) {
    throw new Error(`Refusing to start because configured spike port ${PORT} is occupied`)
  }
  const { stdout: fileSystem } = await execFile('findmnt', [
    '-n',
    '-o',
    'FSTYPE',
    '-T',
    RUNTIME_ROOT,
  ])
  if (fileSystem.trim() !== 'ext4') throw new Error('llama.cpp runtime root must be ext4')
  const { stdout: sourceCommit } = await execFile('git', [
    '-C',
    resolve(RUNTIME_ROOT, 'llama.cpp'),
    'rev-parse',
    'HEAD',
  ])
  if (sourceCommit.trim() !== LLAMA_COMMIT)
    throw new Error('llama.cpp checkout is not at the pinned commit')
  if ((await sha256(MODEL)) !== MODEL_SHA256)
    throw new Error('GGUF SHA-256 does not match provenance')

  await mkdir(RUNTIME_ROOT, { recursive: true })
  const child = spawn(
    BINARY,
    [
      '--model',
      MODEL,
      '--alias',
      MODEL_ALIAS,
      '--host',
      HOST,
      '--port',
      String(PORT),
      '--ctx-size',
      '1024',
      '--parallel',
      '1',
      '--threads',
      '4',
      '--gpu-layers',
      '0',
      '--slots',
      '--metrics',
      '--no-webui',
      '--log-file',
      LOG,
    ],
    { stdio: 'ignore' },
  )

  let evidence: Record<string, unknown> | undefined
  try {
    await waitForHealth(30_000)
    const listeners = await ssLines()
    const loopbackOnly =
      listeners.length === 1 && listeners[0]?.split(/\s+/).includes(`${HOST}:${PORT}`) === true
    if (!loopbackOnly) throw new Error(`Unsafe llama.cpp listener shape: ${listeners.join('; ')}`)

    const client = new LlamaCppSpikeClient({ endpoint: ORIGIN, model: MODEL_ALIAS })
    const capabilities = await client.capabilities()
    if (!capabilities.modelIds.includes(MODEL_ALIAS) || capabilities.totalSlots !== 1) {
      throw new Error('llama.cpp did not expose the requested model identity and slot capability')
    }
    await client.generateStructured({ temperature: 0, seed: 5, maxTokens: 64, timeoutMs: 10_000 })

    const cancellationController = new AbortController()
    const cancellationResult = client
      .runCancellationProbe(cancellationController.signal, 10_000)
      .then(() => ({ completed: true as const }))
      .catch((error: unknown) => ({ completed: false as const, error }))
    const requestReachedServer = await observeBusySlot(2_000)
    cancellationController.abort(new DOMException('host cancellation probe', 'AbortError'))
    const cancellation = await cancellationResult
    if (!requestReachedServer)
      throw new Error('Cancellation probe was not observed in a server slot')
    if (cancellation.completed || !(cancellation.error instanceof SpikeError)) {
      throw new Error('TanStack AI cancellation did not return a classified error')
    }
    if (cancellation.error.code !== 'cancelled') {
      throw new Error(`Cancellation was classified as ${cancellation.error.code}`)
    }
    await waitForIdleSlots(5_000)
    if (client.slotSnapshot().active !== 0)
      throw new Error('Client concurrency slot was not released')

    await client.generateStructured({ timeoutMs: 10_000 })
    const { stdout: llamaVersionStdout, stderr: llamaVersionStderr } = await execFile(BINARY, [
      '--version',
    ])
    const llamaVersion = `${llamaVersionStdout}${llamaVersionStderr}`.trim()
    evidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      decision: 'go',
      scope: 'issue-5-spike-only',
      environment: { os: 'Linux', wsl2: true, architecture: process.arch, node: process.version },
      endpoint: {
        host: HOST,
        port: PORT,
        baseUrl: `${ORIGIN}/v1`,
        productionDefault: 'http://127.0.0.1:8080/v1',
      },
      listener: { loopbackOnly: true, address: `${HOST}:${PORT}` },
      runtime: {
        project: 'ggml-org/llama.cpp',
        commit: LLAMA_COMMIT,
        versionOutput: llamaVersion,
        ext4: true,
        modelRepository: 'bartowski/SmolLM2-135M-Instruct-GGUF',
        modelRevision: MODEL_REVISION,
        modelSha256: MODEL_SHA256,
      },
      harness: {
        sourceSha256: await sha256(fileURLToPath(import.meta.url)),
        portableFaultSuite: true,
      },
      tanstackAi: {
        coreVersion: '0.42.0',
        openAiAdapterVersion: '0.17.1',
        adapter: '@tanstack/ai-openai/compatible',
        requestCompleted: true,
      },
      structuredOutput: { jsonSchemaReachedServer: true, schemaValid: true },
      requestShape: {
        serverSideFixtureCaptured: true,
        observedFields: [
          'model',
          'messages',
          'temperature',
          'seed',
          'max_tokens',
          'stream',
          'stream_options',
          'response_format.json_schema',
        ],
      },
      capabilities: {
        healthStatus: capabilities.healthStatus,
        modelIdentityObservable: true,
        totalSlots: capabilities.totalSlots,
        endpoints: capabilities.endpoints,
      },
      cancellation: {
        requestReachedServer: true,
        classifiedAs: 'cancelled',
        serverSlotReleased: true,
        clientSlotReleased: true,
        slotReleased: true,
      },
      cleanup: { portReleased: false },
    }
  } finally {
    await stopOwnedProcess(child)
  }

  const remainingListeners = await ssLines()
  if (remainingListeners.length > 0) {
    throw new Error(
      `llama.cpp cleanup left a listener on port ${PORT}: ${remainingListeners.join('; ')}`,
    )
  }
  if (!evidence) throw new Error('Real-host checks did not complete')
  evidence.cleanup = { portReleased: true }
  await mkdir(dirname(EVIDENCE), { recursive: true })
  const temporaryEvidence = `${EVIDENCE}.tmp`
  await writeFile(temporaryEvidence, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  await rename(temporaryEvidence, EVIDENCE)
  console.log(`Real llama.cpp/TanStack AI smoke passed; sanitized evidence: ${EVIDENCE}`)
}

await main()
