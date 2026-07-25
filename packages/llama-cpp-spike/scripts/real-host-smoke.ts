import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  LlamaCppSpikeClient,
  LoopbackRecordingFetch,
  loopbackHttpFetch,
  readImplementationIdentity,
  type SanitizedRequestCapture,
  SpikeError,
} from '../src'
import {
  spawnPipedChild,
  validateExternalPath,
  validateExternalRuntime,
  withOwnedServer,
} from './host-runtime-safety'

const execFile = promisify(execFileCallback)
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, '../..')
const RUNTIME_ROOT_INPUT = resolve(
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
const EVIDENCE = resolve(PACKAGE_ROOT, 'evidence/real-host-run.json')
const ATTACKER_ORIGIN = 'https://attacker.invalid'

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function sha256Json(value: unknown): string | null {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? null : createHash('sha256').update(serialized).digest('hex')
}

function authorizationHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` }
}

async function ssLines(): Promise<Array<string>> {
  const { stdout } = await execFile('ss', ['-H', '-ltn', `( sport = :${PORT} )`])
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

async function waitForHealth(
  timeoutMs: number,
  apiKey: string,
  throwIfChildError: () => void,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    throwIfChildError()
    try {
      const response = await fetch(`${ORIGIN}/health`, {
        headers: authorizationHeaders(apiKey),
      })
      if (response.ok && ((await response.json()) as { status?: string }).status === 'ok') return
    } catch {
      // The process is still loading.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw new Error('llama.cpp did not become healthy before the startup deadline')
}

async function readSlots(apiKey: string): Promise<Array<{ is_processing?: boolean }>> {
  const response = await fetch(`${ORIGIN}/slots`, { headers: authorizationHeaders(apiKey) })
  if (!response.ok) throw new Error(`Slot probe failed with HTTP ${response.status}`)
  return (await response.json()) as Array<{ is_processing?: boolean }>
}

async function slotsIdle(apiKey: string): Promise<boolean> {
  try {
    const slots = await readSlots(apiKey)
    return slots.length > 0 && slots.every((slot) => slot.is_processing === false)
  } catch {
    return false
  }
}

async function observeBusySlot(timeoutMs: number, apiKey: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await readSlots(apiKey)).some((slot) => slot.is_processing === true)) return true
    } catch {
      // Retry only within the bounded observation window.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2))
  }
  return false
}

async function waitForIdleSlots(timeoutMs: number, apiKey: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await slotsIdle(apiKey)) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
  throw new Error('llama.cpp did not release its inference slot')
}

interface MonitoredResponses {
  readonly responses: Array<Response>
  readonly slotObservedBusy: boolean
  readonly slotSamples: number
}

async function monitorUnauthenticatedRequests(
  requests: Array<Promise<Response>>,
  apiKey: string,
): Promise<MonitoredResponses> {
  let completed = false
  let slotObservedBusy = false
  let slotSamples = 0
  const responsesPromise = Promise.all(requests).finally(() => {
    completed = true
  })
  while (!completed) {
    const slots = await readSlots(apiKey)
    slotSamples += 1
    if (slots.some((slot) => slot.is_processing === true)) slotObservedBusy = true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
  }
  const responses = await responsesPromise
  for (const response of responses) await response.text()
  return { responses, slotObservedBusy, slotSamples }
}

async function probeBrowserBoundary(apiKey: string): Promise<Record<string, unknown>> {
  if (!(await slotsIdle(apiKey))) throw new Error('Security probe requires an idle slot')
  const optionRequests = Array.from({ length: 16 }, () =>
    fetch(`${ORIGIN}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: {
        origin: ATTACKER_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    }),
  )
  const options = await monitorUnauthenticatedRequests(optionRequests, apiKey)
  const postBody = JSON.stringify({
    model: MODEL_ALIAS,
    messages: [{ role: 'user', content: 'Synthetic unauthorized browser probe.' }],
    max_tokens: 4_096,
    stream: true,
  })
  const postRequests = Array.from({ length: 16 }, () =>
    fetch(`${ORIGIN}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ATTACKER_ORIGIN },
      body: postBody,
    }),
  )
  const posts = await monitorUnauthenticatedRequests(postRequests, apiKey)
  await waitForIdleSlots(2_000, apiKey)

  const optionStatuses = options.responses.map((response) => response.status)
  const postStatuses = posts.responses.map((response) => response.status)
  const attackerAllowOrigins = [
    ...new Set(
      [...options.responses, ...posts.responses]
        .map((response) => response.headers.get('access-control-allow-origin'))
        .filter((value): value is string => value !== null),
    ),
  ]
  if (optionStatuses.some((status) => status < 200 || status >= 300)) {
    throw new Error(`Unexpected unauthenticated OPTIONS statuses: ${optionStatuses.join(',')}`)
  }
  if (postStatuses.some((status) => status !== 401)) {
    throw new Error(
      `Unauthenticated POST did not consistently return 401: ${postStatuses.join(',')}`,
    )
  }
  if (options.slotObservedBusy || posts.slotObservedBusy || !(await slotsIdle(apiKey))) {
    throw new Error('Unauthenticated browser-origin traffic occupied an inference slot')
  }
  if (attackerAllowOrigins.length !== 0) {
    throw new Error(`Attacker Origin received CORS permission: ${attackerAllowOrigins.join(',')}`)
  }

  return {
    attackerOrigin: ATTACKER_ORIGIN,
    apiKeySent: false,
    options: {
      attempts: optionStatuses.length,
      statuses: [...new Set(optionStatuses)],
      slotSamples: options.slotSamples,
      slotObservedBusy: options.slotObservedBusy,
      accessControlAllowOrigin: null,
    },
    posts: {
      attempts: postStatuses.length,
      statuses: [...new Set(postStatuses)],
      slotSamples: posts.slotSamples,
      slotObservedBusy: posts.slotObservedBusy,
      inferenceAuthorized: false,
    },
    finalSlotIdle: true,
  }
}

function inspectStructuredRequest(body: Uint8Array): Record<string, unknown> {
  const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>
  const responseFormat = parsed.response_format as
    | { type?: unknown; json_schema?: { name?: unknown; strict?: unknown; schema?: unknown } }
    | undefined
  const jsonSchema = responseFormat?.json_schema
  return {
    model: parsed.model,
    temperature: parsed.temperature,
    seed: parsed.seed,
    maxTokens: parsed.max_tokens,
    stream: parsed.stream,
    streamOptions: parsed.stream_options,
    messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : null,
    responseFormat: responseFormat
      ? {
          type: responseFormat.type,
          name: jsonSchema?.name,
          strict: jsonSchema?.strict,
          schema: jsonSchema?.schema,
          schemaSha256: sha256Json(jsonSchema?.schema),
        }
      : null,
  }
}

function assertRealRequestCapture(capture: SanitizedRequestCapture | undefined): void {
  if (!capture) throw new Error('The real structured request was not captured')
  const fields = capture.assertedFields as {
    model?: unknown
    temperature?: unknown
    seed?: unknown
    maxTokens?: unknown
    stream?: unknown
    streamOptions?: { include_usage?: unknown }
    messageCount?: unknown
    responseFormat?: { type?: unknown; name?: unknown; strict?: unknown; schema?: unknown }
  }
  const schema = fields.responseFormat?.schema as
    | { type?: unknown; required?: unknown; additionalProperties?: unknown; properties?: unknown }
    | undefined
  if (
    capture.path !== '/v1/chat/completions' ||
    capture.backendStatus !== 200 ||
    !capture.authorization.present ||
    capture.authorization.scheme !== 'Bearer' ||
    fields.model !== MODEL_ALIAS ||
    fields.temperature !== 0 ||
    fields.seed !== 5 ||
    fields.maxTokens !== 64 ||
    fields.stream !== true ||
    fields.streamOptions?.include_usage !== true ||
    fields.messageCount !== 1 ||
    fields.responseFormat?.type !== 'json_schema' ||
    fields.responseFormat.name !== 'structured_output' ||
    fields.responseFormat.strict !== true ||
    schema?.type !== 'object' ||
    schema.additionalProperties !== false ||
    !Array.isArray(schema.required) ||
    !schema.required.includes('verdict') ||
    !schema.required.includes('summary') ||
    typeof schema.properties !== 'object'
  ) {
    throw new Error('Real request capture did not contain the required llama.cpp request shape')
  }
}

async function main(): Promise<void> {
  const { stdout: gitDirectoryOutput } = await execFile(
    'git',
    ['rev-parse', '--absolute-git-dir'],
    {
      cwd: REPOSITORY_ROOT,
    },
  )
  const { stdout: commonGitDirectoryOutput } = await execFile(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: REPOSITORY_ROOT },
  )
  const externalRuntime = await validateExternalRuntime({
    runtimeRootInput: RUNTIME_ROOT_INPUT,
    worktreeRoot: REPOSITORY_ROOT,
    repositoryRoot: dirname(commonGitDirectoryOutput.trim()),
    gitDirectory: gitDirectoryOutput.trim(),
    paths: [
      { path: resolve(RUNTIME_ROOT_INPUT, 'llama.cpp'), pathClass: 'source' },
      {
        path: resolve(RUNTIME_ROOT_INPUT, 'llama.cpp/build/bin/llama-server'),
        pathClass: 'binary',
      },
      { path: resolve(RUNTIME_ROOT_INPUT, 'models'), pathClass: 'model' },
      {
        path: resolve(RUNTIME_ROOT_INPUT, 'models/SmolLM2-135M-Instruct-Q4_K_M.gguf'),
        pathClass: 'model',
      },
      { path: resolve(RUNTIME_ROOT_INPUT, 'host-build.json'), pathClass: 'manifest' },
      { path: resolve(RUNTIME_ROOT_INPUT, 'license-evidence'), pathClass: 'license' },
      ...[
        'llama.cpp-LICENSE',
        'quantization-README.md',
        'instruct-README.md',
        'base-README.md',
      ].map((name) => ({
        path: resolve(RUNTIME_ROOT_INPUT, 'license-evidence', name),
        pathClass: 'license',
      })),
      {
        path: resolve(RUNTIME_ROOT_INPUT, '.run-api-key-validation'),
        pathClass: 'temporary',
      },
      {
        path: resolve(RUNTIME_ROOT_INPUT, '.llama.cpp.prepare.validation'),
        pathClass: 'temporary',
      },
      {
        path: resolve(RUNTIME_ROOT_INPUT, 'models/SmolLM2-135M-Instruct-Q4_K_M.gguf.part'),
        pathClass: 'temporary',
      },
      { path: resolve(RUNTIME_ROOT_INPUT, 'host-build.json.tmp'), pathClass: 'temporary' },
    ],
  })
  const runtimeRoot = externalRuntime.root
  const temporaryEvidence = `${EVIDENCE}.tmp`
  await validateExternalPath(PACKAGE_ROOT, EVIDENCE)
  await validateExternalPath(PACKAGE_ROOT, temporaryEvidence)
  const binary = resolve(runtimeRoot, 'llama.cpp/build/bin/llama-server')
  const model = resolve(runtimeRoot, 'models/SmolLM2-135M-Instruct-Q4_K_M.gguf')
  const buildManifestPath = resolve(runtimeRoot, 'host-build.json')

  if ((await ssLines()).length > 0) {
    throw new Error(`Refusing to start because configured spike port ${PORT} is occupied`)
  }
  const { stdout: statusOutput } = await execFile('git', ['status', '--porcelain'], {
    cwd: REPOSITORY_ROOT,
  })
  if (statusOutput !== '')
    throw new Error('Real evidence must be generated from a clean Git commit')
  const implementation = await readImplementationIdentity(
    REPOSITORY_ROOT,
    process.env.LLAMA_CPP_SPIKE_IMPLEMENTATION_COMMIT ?? 'HEAD',
  )
  const { stdout: sourceCommit } = await execFile('git', [
    '-C',
    resolve(runtimeRoot, 'llama.cpp'),
    'rev-parse',
    'HEAD',
  ])
  if (sourceCommit.trim() !== LLAMA_COMMIT)
    throw new Error('llama.cpp checkout is not at the pinned commit')
  const { stdout: sourceStatus } = await execFile('git', [
    '-C',
    resolve(runtimeRoot, 'llama.cpp'),
    'status',
    '--porcelain',
    '--untracked-files=no',
  ])
  if (sourceStatus !== '') throw new Error('llama.cpp source checkout is not clean')
  if ((await sha256(model)) !== MODEL_SHA256)
    throw new Error('GGUF SHA-256 does not match provenance')
  const binarySha256 = await sha256(binary)
  const buildManifest = JSON.parse(await readFile(buildManifestPath, 'utf8')) as {
    llamaCommit?: string
    binarySha256?: string
    modelSha256?: string
    cleanSourceCheckout?: boolean
    cleanRebuild?: boolean
  }
  if (
    buildManifest.llamaCommit !== LLAMA_COMMIT ||
    buildManifest.binarySha256 !== binarySha256 ||
    buildManifest.modelSha256 !== MODEL_SHA256 ||
    buildManifest.cleanSourceCheckout !== true ||
    buildManifest.cleanRebuild !== true
  ) {
    throw new Error('External build manifest does not match the clean pinned runtime')
  }

  const ownership = await withOwnedServer({
    runtimeRoot,
    spawnChild: (apiKeyFile) =>
      spawnPipedChild(binary, [
        '--model',
        model,
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
        '--api-key-file',
        apiKeyFile,
        '--cors-origins',
        'localhost',
        '--no-cors-credentials',
        '--log-disable',
      ]),
    run: async ({ apiKey, throwIfChildError }) => {
      await waitForHealth(30_000, apiKey, throwIfChildError)
      const listeners = await ssLines()
      const loopbackOnly =
        listeners.length === 1 && listeners[0]?.split(/\s+/).includes(`${HOST}:${PORT}`) === true
      if (!loopbackOnly) throw new Error(`Unsafe llama.cpp listener shape: ${listeners.join('; ')}`)

      const browserBoundary = await probeBrowserBoundary(apiKey)
      const recordingFetch = new LoopbackRecordingFetch({
        fetch: loopbackHttpFetch,
        inspectBody: inspectStructuredRequest,
      })
      const client = new LlamaCppSpikeClient({
        endpoint: ORIGIN,
        model: MODEL_ALIAS,
        apiKey,
        fetch: recordingFetch.fetch,
      })
      const capabilities = await client.capabilities()
      if (!capabilities.modelIds.includes(MODEL_ALIAS) || capabilities.totalSlots !== 1) {
        throw new Error('llama.cpp did not expose the requested model identity and slot capability')
      }
      await client.generateStructured({ temperature: 0, seed: 5, maxTokens: 64, timeoutMs: 30_000 })
      const realRequestCapture = recordingFetch.captures.find(
        (capture) =>
          (capture.assertedFields.responseFormat as { type?: unknown } | null)?.type ===
          'json_schema',
      )
      assertRealRequestCapture(realRequestCapture)

      const cancellationController = new AbortController()
      const cancellationResult = client
        .runCancellationProbe(cancellationController.signal, 10_000)
        .then(() => ({ completed: true as const }))
        .catch((error: unknown) => ({ completed: false as const, error }))
      const cancellationReachedServer = await observeBusySlot(2_000, apiKey)
      cancellationController.abort(new DOMException('host cancellation probe', 'AbortError'))
      const cancellation = await cancellationResult
      if (!cancellationReachedServer) {
        const outcome = cancellation.completed
          ? 'completed before observation'
          : cancellation.error instanceof SpikeError
            ? `failed as ${cancellation.error.code}`
            : 'failed without a classified error'
        throw new Error(`Cancellation probe was not observed in a server slot (${outcome})`)
      }
      if (cancellation.completed || !(cancellation.error instanceof SpikeError)) {
        throw new Error('TanStack AI cancellation did not return a classified error')
      }
      if (cancellation.error.code !== 'cancelled') {
        throw new Error(`Cancellation was classified as ${cancellation.error.code}`)
      }
      await waitForIdleSlots(5_000, apiKey)
      if (client.slotSnapshot().active !== 0)
        throw new Error('Client concurrency slot was not released after cancellation')

      const timeoutController = new AbortController()
      const timeoutResult = client
        .runCancellationProbe(timeoutController.signal, 200)
        .then(() => ({ completed: true as const }))
        .catch((error: unknown) => ({ completed: false as const, error }))
      const timeoutReachedServer = await observeBusySlot(150, apiKey)
      const timeout = await timeoutResult
      if (!timeoutReachedServer) throw new Error('Timeout probe was not observed in a server slot')
      if (timeout.completed || !(timeout.error instanceof SpikeError)) {
        throw new Error('TanStack AI timeout did not return a classified error')
      }
      if (timeout.error.code !== 'timeout') {
        throw new Error(`Deadline was classified as ${timeout.error.code}`)
      }
      await waitForIdleSlots(5_000, apiKey)
      if (client.slotSnapshot().active !== 0)
        throw new Error('Client concurrency slot was not released after timeout')

      await client.generateStructured({ timeoutMs: 30_000 })
      throwIfChildError()
      const { stdout: llamaVersionStdout, stderr: llamaVersionStderr } = await execFile(binary, [
        '--version',
      ])
      const llamaVersion = `${llamaVersionStdout}${llamaVersionStderr}`.trim()
      return {
        schemaVersion: 2,
        generatedAt: new Date().toISOString(),
        decision: 'go',
        scope: 'issue-5-spike-only',
        git: {
          implementationCommit: implementation.commit,
          implementationTree: implementation.tree,
          canonicalSourceSetSha256: implementation.canonicalSourceSetSha256,
          sourceFiles: implementation.sourceFiles,
        },
        environment: { os: 'Linux', wsl2: true, architecture: process.arch, node: process.version },
        endpoint: {
          host: HOST,
          port: PORT,
          baseUrl: `${ORIGIN}/v1`,
          productionDefault: 'http://127.0.0.1:8080/v1',
        },
        listener: { loopbackOnly, address: `${HOST}:${PORT}` },
        runtime: {
          project: 'ggml-org/llama.cpp',
          commit: sourceCommit.trim(),
          versionOutput: llamaVersion,
          binarySha256,
          cleanSourceCheckout: buildManifest.cleanSourceCheckout,
          cleanRebuild: buildManifest.cleanRebuild,
          ext4: true,
          externalRootProof: externalRuntime.proof,
          modelRepository: 'bartowski/SmolLM2-135M-Instruct-GGUF',
          modelRevision: MODEL_REVISION,
          modelSha256: await sha256(model),
        },
        security: {
          apiKey: {
            randomPerRun: true,
            entropyBytes: 32,
            fileMode0600: true,
            passedByFile: true,
            serverSideOnly: true,
            capturedAuthorization: 'redacted',
            logged: false,
            committed: false,
          },
          cors: {
            configuredOrigins: 'localhost',
            credentials: false,
            upstreamDefaultReflectionLimitationDocumented: true,
          },
          browserBoundary,
        },
        tanstackAi: {
          coreVersion: '0.42.0',
          openAiAdapterVersion: '0.17.1',
          adapter: '@tanstack/ai-openai/compatible',
          requestCompleted: true,
        },
        structuredOutput: { jsonSchemaReachedServer: true, schemaValid: true },
        requestShape: {
          boundary: 'loopback-transparent-fetch',
          forwardedToRealBackend: realRequestCapture?.path,
          bodyBytes: realRequestCapture?.bodyBytes,
          bodySha256: realRequestCapture?.bodySha256,
          forwardedBodySha256: realRequestCapture?.forwardedBodySha256,
          authorization: realRequestCapture?.authorization,
          backendStatus: realRequestCapture?.backendStatus,
          observed: realRequestCapture?.assertedFields,
        },
        capabilities: {
          healthStatus: capabilities.healthStatus,
          modelIdentityObservable: capabilities.modelIds.includes(MODEL_ALIAS),
          totalSlots: capabilities.totalSlots,
          endpoints: capabilities.endpoints,
        },
        cancellation: {
          requestReachedServer: cancellationReachedServer,
          classifiedAs: cancellation.error.code,
          serverSlotReleased: await slotsIdle(apiKey),
          clientSlotReleased: client.slotSnapshot().active === 0,
          followUpSucceeded: true,
        },
        timeout: {
          requestReachedServer: timeoutReachedServer,
          classifiedAs: timeout.error.code,
          serverSlotReleased: await slotsIdle(apiKey),
          clientSlotReleased: client.slotSnapshot().active === 0,
          followUpSucceeded: true,
        },
        cleanup: {
          portReleased: false,
          apiKeyFileRemoved: false,
          logsDisabled: true,
          resourcesClosed: false,
        },
      }
    },
  })

  const remainingListeners = await ssLines()
  if (remainingListeners.length > 0) {
    throw new Error(
      `llama.cpp cleanup left a listener on port ${PORT}: ${remainingListeners.join('; ')}`,
    )
  }
  let apiKeyFileRemoved = false
  try {
    await access(ownership.removedApiKeyFile)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    apiKeyFileRemoved = true
  }
  if (!apiKeyFileRemoved) throw new Error('Per-run API-key file remained after cleanup')
  const evidence = ownership.result
  evidence.cleanup = {
    portReleased: true,
    apiKeyFileRemoved: true,
    logsDisabled: true,
    resourcesClosed: true,
  }
  await mkdir(dirname(EVIDENCE), { recursive: true })
  try {
    await writeFile(temporaryEvidence, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
    await rename(temporaryEvidence, EVIDENCE)
  } finally {
    await rm(temporaryEvidence, { force: true })
  }
  console.log(`Real llama.cpp/TanStack AI smoke passed; sanitized evidence: ${EVIDENCE}`)
}

await main()
