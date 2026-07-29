import { type ChildProcess, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { canonicalSha256, type JsonValue } from '@light-novel-audiobook/scoring-harness'
import { z } from 'zod'
import { LlamaCppGateway } from './gateway.js'
import { type ExternalBrainProof, validateExternalBrainPaths } from './path-safety.js'
import type { BenchmarkProfile } from './profiles.js'
import {
  type ChildExitEvidence,
  isGracefulOwnedShutdown,
  type RuntimeCleanupEvidence,
  runtimeCleanupEvidenceSchema,
} from './schemas.js'

const hostManifestFields = {
  llamaCommit: z.string().regex(/^[a-f0-9]{40}$/),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
  modelRevision: z.string().regex(/^[a-f0-9]{40}$/),
  modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
  modelSizeBytes: z.number().int().positive(),
  cmakeConfigurationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  cleanSourceCheckout: z.literal(true),
  cleanRebuild: z.literal(true),
  textModelOnly: z.literal(true),
} as const

const legacyCudaHostManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ...hostManifestFields,
  cudaCompiler: z.string().min(1),
})

const cudaBuildRecordSchema = z.strictObject({
  backend: z.literal('cuda'),
  cudaCompiler: z.string().min(1),
})

const metalBuildRecordSchema = z.strictObject({
  backend: z.literal('metal'),
  target: z.literal('darwin-arm64'),
  compiler: z.string().min(1),
})

const platformHostManifestSchema = z.strictObject({
  schemaVersion: z.literal(2),
  ...hostManifestFields,
  buildRecord: z.discriminatedUnion('backend', [cudaBuildRecordSchema, metalBuildRecordSchema]),
})

export const hostManifestSchema = z.discriminatedUnion('schemaVersion', [
  legacyCudaHostManifestSchema,
  platformHostManifestSchema,
])

export type HostManifest = z.infer<typeof hostManifestSchema>

export function requireCudaCompiler(host: HostManifest): string {
  if (host.schemaVersion === 1) return host.cudaCompiler
  if (host.buildRecord.backend === 'cuda') return host.buildRecord.cudaCompiler
  throw new Error('Host manifest is not a CUDA build')
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function portIsFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const server = createServer()
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      server.removeAllListeners()
      resolvePromise(value)
    }
    server.once('error', () => finish(false))
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => finish(error === undefined))
    })
  })
}

async function pathIsAbsent(path: string): Promise<boolean> {
  try {
    await stat(path)
    return false
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

async function requireFreePort(port: number): Promise<void> {
  if (!(await portIsFree(port))) throw new Error('Benchmark port is occupied')
}

export async function waitForPortRelease(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (await portIsFree(port)) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw new Error('Benchmark port was not released')
}

export function readChildExitEvidence(child: ChildProcess): ChildExitEvidence {
  const observedExited = child.exitCode !== null || child.signalCode !== null
  return {
    observed_exited: observedExited,
    exit_code: child.exitCode,
    signal: child.signalCode,
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (readChildExitEvidence(child).observed_exited) return true
  return await new Promise<boolean>((resolvePromise) => {
    let settled = false
    const finish = (exited: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolvePromise(exited)
    }
    const onExit = (): void => finish(true)
    const timer = setTimeout(() => finish(readChildExitEvidence(child).observed_exited), timeoutMs)
    child.once('exit', onExit)
    if (readChildExitEvidence(child).observed_exited) finish(true)
  })
}

export async function stopOwnedChild(
  child: ChildProcess,
  options: { termTimeoutMs?: number; killTimeoutMs?: number } = {},
): Promise<Omit<RuntimeCleanupEvidence, 'api_key_file_removed' | 'port_released'>> {
  if (readChildExitEvidence(child).observed_exited || child.pid === undefined) {
    return {
      schema_version: 'runtime-cleanup@1',
      child_exit_observed: true,
      exit_code: child.exitCode,
      signal: child.signalCode,
      termination: 'already_exited',
      sigterm_sent: false,
      sigkill_sent: false,
      exit_awaited: true,
    }
  }

  const sigtermSent = child.kill('SIGTERM')
  if (await waitForChildExit(child, options.termTimeoutMs ?? 10_000)) {
    return {
      schema_version: 'runtime-cleanup@1',
      child_exit_observed: true,
      exit_code: child.exitCode,
      signal: child.signalCode,
      termination: 'sigterm',
      sigterm_sent: sigtermSent,
      sigkill_sent: false,
      exit_awaited: true,
    }
  }

  const sigkillSent = child.kill('SIGKILL')
  if (!(await waitForChildExit(child, options.killTimeoutMs ?? 10_000))) {
    throw new Error('Owned llama.cpp child did not exit after SIGKILL')
  }
  return {
    schema_version: 'runtime-cleanup@1',
    child_exit_observed: true,
    exit_code: child.exitCode,
    signal: child.signalCode,
    termination: 'sigkill',
    sigterm_sent: sigtermSent,
    sigkill_sent: sigkillSent,
    exit_awaited: true,
  }
}

async function waitForHealth(
  origin: string,
  key: string,
  child: ChildProcess,
  childError: () => Error | undefined,
): Promise<void> {
  const deadline = performance.now() + 10 * 60_000
  while (performance.now() < deadline) {
    const emittedError = childError()
    if (emittedError) throw new Error('llama.cpp failed to spawn', { cause: emittedError })
    if (readChildExitEvidence(child).observed_exited)
      throw new Error('llama.cpp exited during load')
    try {
      const response = await fetch(`${origin}/health`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(2_000),
      })
      if (response.ok) return
    } catch {
      // Expected while the listener/model is starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error('llama.cpp model load timed out')
}

function runtimeConfiguration(
  profile: BenchmarkProfile,
  host: HostManifest,
  port: number,
): JsonValue {
  return {
    profile,
    host,
    listener: { host: '127.0.0.1', port, parallel: 1 },
    server: {
      prompt_cache: false,
      cors_origins: 'localhost',
      cors_credentials: false,
      web_ui: false,
      metrics: true,
      slots: true,
      logs: false,
    },
  } as unknown as JsonValue
}

export interface PinnedRuntimeContext {
  readonly host: HostManifest
  readonly hostManifestSha256: string
  readonly runtimeConfigurationSha256: string
  readonly externalRootProof: ExternalBrainProof
  readonly child: ChildProcess
}

export function assertSuccessfulRuntimeLifecycle(
  workCompletionExit: ChildExitEvidence,
  cleanup: RuntimeCleanupEvidence,
): void {
  if (workCompletionExit.observed_exited) {
    throw new Error('llama.cpp exited before benchmark work completed')
  }
  if (!isGracefulOwnedShutdown(cleanup)) {
    throw new Error('llama.cpp did not complete the expected graceful owned shutdown')
  }
}

export interface PinnedRuntimeResult<T> {
  readonly value: T
  readonly context: Omit<PinnedRuntimeContext, 'child'>
  readonly cleanup: RuntimeCleanupEvidence
}

export async function withPinnedRuntime<T>(options: {
  runtimeRoot: string
  repositoryRoot: string
  gitDirectory: string
  profile: BenchmarkProfile
  port: number
  run: (gateway: LlamaCppGateway, context: PinnedRuntimeContext) => Promise<T>
}): Promise<PinnedRuntimeResult<T>> {
  if (options.profile.order !== 0) throw new Error('Only the pinned primary runtime is prepared')
  const lexicalRoot = resolve(options.runtimeRoot)
  const manifestPath = join(lexicalRoot, 'host-build.json')
  const binary = join(lexicalRoot, 'llama.cpp/build/bin/llama-server')
  const model = join(lexicalRoot, 'models', options.profile.file)
  const keyPath = join(
    lexicalRoot,
    `.benchmark-api-key-${process.pid}-${randomBytes(6).toString('hex')}`,
  )
  const validation = await validateExternalBrainPaths({
    runtimeRoot: lexicalRoot,
    repositoryRoot: options.repositoryRoot,
    gitDirectory: options.gitDirectory,
    candidates: [
      { path: manifestPath, pathClass: 'manifest' },
      { path: binary, pathClass: 'binary' },
      { path: model, pathClass: 'model' },
      { path: keyPath, pathClass: 'temporary' },
    ],
  })

  const manifestBytes = await readFile(manifestPath, 'utf8')
  const host = hostManifestSchema.parse(JSON.parse(manifestBytes))
  const hostManifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
  if (
    host.llamaCommit !== '555881ebc8b0fc0402b30e09258a32a7bfd13c52' ||
    host.modelRevision !== options.profile.revision ||
    host.modelSha256 !== options.profile.modelSha256
  ) {
    throw new Error('External runtime does not match pinned provenance')
  }
  if ((await stat(model)).size !== host.modelSizeBytes) throw new Error('Pinned model size changed')
  if ((await sha256File(model)) !== host.modelSha256) throw new Error('Pinned model hash changed')
  if ((await sha256File(binary)) !== host.binarySha256)
    throw new Error('Pinned binary hash changed')
  await requireFreePort(options.port)

  const key = randomBytes(32).toString('base64url')
  const args = [
    '--model',
    model,
    '--alias',
    options.profile.id,
    '--host',
    '127.0.0.1',
    '--port',
    String(options.port),
    '--ctx-size',
    String(options.profile.contextSize),
    '--parallel',
    '1',
    '--n-gpu-layers',
    String(options.profile.gpuLayers),
    '--cache-type-k',
    options.profile.cacheTypeK,
    '--cache-type-v',
    options.profile.cacheTypeV,
    '--flash-attn',
    'on',
    '--batch-size',
    String(options.profile.batchSize),
    '--ubatch-size',
    String(options.profile.microBatchSize),
    '--threads',
    String(options.profile.threads),
    '--reasoning',
    options.profile.reasoning,
    '--no-cache-prompt',
    '--api-key-file',
    keyPath,
    '--cors-origins',
    'localhost',
    '--no-cors-credentials',
    '--no-webui',
    '--metrics',
    '--slots',
    '--log-disable',
  ]
  let child: ChildProcess | undefined
  let context: PinnedRuntimeContext | undefined
  let emittedChildError: Error | undefined
  const onChildError = (error: Error): void => {
    emittedChildError = error
  }
  let value: T | undefined
  let workCompletionExit: ChildExitEvidence | undefined
  let runError: unknown
  let cleanupError: unknown
  let cleanupBase:
    | Omit<RuntimeCleanupEvidence, 'api_key_file_removed' | 'port_released'>
    | undefined
  let keyRemoved = false
  let portReleased = false
  try {
    await writeFile(keyPath, `${key}\n`, { flag: 'wx', mode: 0o600 })
    await chmod(keyPath, 0o600)
    child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    child.on('error', onChildError)
    context = {
      host,
      hostManifestSha256,
      runtimeConfigurationSha256: canonicalSha256(
        runtimeConfiguration(options.profile, host, options.port),
      ),
      externalRootProof: validation.proof,
      child,
    }
    await waitForHealth(`http://127.0.0.1:${options.port}`, key, child, () => emittedChildError)
    const gateway = new LlamaCppGateway(`http://127.0.0.1:${options.port}/`, key)
    value = await options.run(gateway, context)
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
    workCompletionExit = readChildExitEvidence(child)
  } catch (error: unknown) {
    runError = error
  } finally {
    try {
      if (child) cleanupBase = await stopOwnedChild(child)
    } catch (error: unknown) {
      cleanupError = error
    } finally {
      child?.removeListener('error', onChildError)
    }
    try {
      await rm(keyPath, { force: true })
      keyRemoved = await pathIsAbsent(keyPath)
      if (!keyRemoved) cleanupError ??= new Error('API-key file still exists after cleanup')
    } catch (error: unknown) {
      cleanupError ??= error
    }
    try {
      await waitForPortRelease(options.port)
      portReleased = true
    } catch (error: unknown) {
      cleanupError ??= error
    }
  }
  if (cleanupError) throw cleanupError
  if (value === undefined || context === undefined || cleanupBase === undefined) {
    if (runError) throw runError
    throw new Error('Runtime did not complete')
  }
  const cleanup = runtimeCleanupEvidenceSchema.parse({
    ...cleanupBase,
    api_key_file_removed: keyRemoved,
    port_released: portReleased,
  })
  if (runError) throw runError
  if (!workCompletionExit) throw new Error('Runtime work-completion state was not captured')
  assertSuccessfulRuntimeLifecycle(workCompletionExit, cleanup)
  return {
    value,
    context: {
      host: context.host,
      hostManifestSha256: context.hostManifestSha256,
      runtimeConfigurationSha256: context.runtimeConfigurationSha256,
      externalRootProof: context.externalRootProof,
    },
    cleanup,
  }
}

export function runtimeConfigurationSha256(
  profile: BenchmarkProfile,
  host: HostManifest,
  port: number,
): string {
  return canonicalSha256(runtimeConfiguration(profile, host, port))
}
