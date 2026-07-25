import { type ChildProcess, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, readFile, realpath, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { canonicalSha256, type JsonValue } from '@light-novel-audiobook/scoring-harness'
import { z } from 'zod'
import { LlamaCppGateway } from './gateway.js'
import type { BenchmarkProfile } from './profiles.js'

const hostManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  llamaCommit: z.string().regex(/^[a-f0-9]{40}$/),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
  modelRevision: z.string().regex(/^[a-f0-9]{40}$/),
  modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
  modelSizeBytes: z.number().int().positive(),
  cudaCompiler: z.string().min(1),
  cmakeConfigurationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  cleanSourceCheckout: z.literal(true),
  cleanRebuild: z.literal(true),
  textModelOnly: z.literal(true),
})

export type HostManifest = z.infer<typeof hostManifestSchema>

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function requireFreePort(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => (error ? reject(error) : resolvePromise()))
    })
  })
}

async function waitForHealth(
  origin: string,
  key: string,
  child: ChildProcess,
  childError: () => Error | undefined,
): Promise<void> {
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    if (childError()) throw new Error('llama.cpp failed to spawn', { cause: childError() })
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('llama.cpp exited during load')
    try {
      const response = await fetch(`${origin}/health`, {
        headers: { authorization: `Bearer ${key}` },
      })
      if (response.ok) return
    } catch {
      // Expected while the listener/model is starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000))
  }
  throw new Error('llama.cpp model load timed out')
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise())),
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

export async function withPinnedRuntime<T>(options: {
  runtimeRoot: string
  profile: BenchmarkProfile
  port: number
  run: (gateway: LlamaCppGateway, host: HostManifest, child: ChildProcess) => Promise<T>
}): Promise<T> {
  if (options.profile.order !== 0) throw new Error('Only the pinned primary runtime is prepared')
  const root = await realpath(options.runtimeRoot)
  if ((await statfs(root)).type !== 0xef53) throw new Error('Pinned brain runtime must use ext4')
  const manifestPath = join(root, 'host-build.json')
  const host = hostManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
  if (
    host.llamaCommit !== '555881ebc8b0fc0402b30e09258a32a7bfd13c52' ||
    host.modelRevision !== options.profile.revision ||
    host.modelSha256 !== options.profile.modelSha256
  ) {
    throw new Error('External runtime does not match pinned provenance')
  }
  const binary = resolve(root, 'llama.cpp/build/bin/llama-server')
  const model = resolve(root, 'models', options.profile.file)
  if ((await stat(model)).size !== host.modelSizeBytes) throw new Error('Pinned model size changed')
  if ((await sha256File(model)) !== host.modelSha256) throw new Error('Pinned model hash changed')
  if ((await sha256File(binary)) !== host.binarySha256)
    throw new Error('Pinned binary hash changed')
  await requireFreePort(options.port)

  const key = randomBytes(32).toString('base64url')
  const keyPath = join(root, `.benchmark-api-key-${process.pid}-${randomBytes(6).toString('hex')}`)
  await writeFile(keyPath, `${key}\n`, { flag: 'wx', mode: 0o600 })
  await chmod(keyPath, 0o600)
  const alias = options.profile.id
  const args = [
    '--model',
    model,
    '--alias',
    alias,
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
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'ignore'] })
  let emittedChildError: Error | undefined
  const onChildError = (error: Error): void => {
    emittedChildError = error
  }
  child.on('error', onChildError)
  try {
    await waitForHealth(`http://127.0.0.1:${options.port}`, key, child, () => emittedChildError)
    const gateway = new LlamaCppGateway(`http://127.0.0.1:${options.port}/`, key)
    return await options.run(gateway, host, child)
  } finally {
    await stop(child)
    child.removeListener('error', onChildError)
    await rm(keyPath, { force: true })
  }
}

export function runtimeConfigurationSha256(profile: BenchmarkProfile, host: HostManifest): string {
  return canonicalSha256({ profile, host } as unknown as JsonValue)
}
