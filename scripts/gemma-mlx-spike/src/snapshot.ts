import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpikeConfig } from './args.js'

export interface SnapshotFileRecord {
  readonly relativePath: string
  readonly sizeBytes: number
  /** Present for every required small file and, in a measurement run, for weight shards too. */
  readonly sha256: string | null
}

export interface VerifiedSnapshot {
  readonly snapshotPath: string
  readonly revision: string | null
  readonly resolution: 'explicit-path' | 'hf-cache'
  readonly hfRepository: string
  readonly files: readonly SnapshotFileRecord[]
  readonly totalSizeBytes: number
  /** Effective context length from the model config; mlx_lm.server has no --context flag. */
  readonly maxPositionEmbeddings: number | null
  readonly modelType: string | null
  readonly quantization: unknown
  readonly weightsHashed: boolean
}

/** Files that must exist for mlx_lm to serve the snapshot; verified and always hashed. */
const SMALL_HASH_LIMIT_BYTES = 64 * 1024 * 1024

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function hfRepoCacheDirName(repository: string): string {
  const [namespace, name] = repository.split('/')
  if (
    namespace === undefined ||
    name === undefined ||
    namespace.length === 0 ||
    name.length === 0
  ) {
    throw new Error(`HF repository must be <namespace>/<name>, got: ${repository}`)
  }
  return `models--${namespace}--${name}`
}

/**
 * Resolves the already-cached model to one immutable snapshot directory. A floating ref is never
 * passed to the server: with multiple cached revisions the run fails closed unless --revision
 * selects one, and the selected path is always the snapshots/<revision> directory itself.
 */
export async function resolveSnapshotPath(config: SpikeConfig): Promise<{
  snapshotPath: string
  revision: string | null
  resolution: 'explicit-path' | 'hf-cache'
}> {
  if (config.snapshotPath !== undefined) {
    const snapshotPath = await realpath(config.snapshotPath).catch(() => {
      throw new Error(`Snapshot path does not exist: ${config.snapshotPath}`)
    })
    if (!(await stat(snapshotPath)).isDirectory()) {
      throw new Error(`Snapshot path is not a directory: ${snapshotPath}`)
    }
    const revision = /[\\/]snapshots[\\/]([^\\/]+)$/.exec(snapshotPath)?.[1] ?? null
    return { snapshotPath, revision, resolution: 'explicit-path' }
  }

  const repoDir = join(config.hfCacheDir, hfRepoCacheDirName(config.hfRepository))
  const snapshotsDir = join(repoDir, 'snapshots')
  const entries = await readdir(snapshotsDir, { withFileTypes: true }).catch(() => {
    throw new Error(
      `No HF snapshot cache for ${config.hfRepository} under ${config.hfCacheDir}; ` +
        'the spike never downloads — pre-populate the cache first',
    )
  })
  const revisions = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  if (revisions.length === 0) {
    throw new Error(`HF cache for ${config.hfRepository} contains no snapshots`)
  }
  let selected: string
  if (config.hfRevision !== undefined) {
    if (!revisions.includes(config.hfRevision)) {
      throw new Error(
        `Requested revision ${config.hfRevision} is not cached for ${config.hfRepository} ` +
          `(cached: ${revisions.join(', ')})`,
      )
    }
    selected = config.hfRevision
  } else if (revisions.length === 1 && revisions[0] !== undefined) {
    selected = revisions[0]
  } else {
    throw new Error(
      `HF cache for ${config.hfRepository} holds ${revisions.length} revisions ` +
        `(${revisions.join(', ')}); failing closed — pass --revision to select one`,
    )
  }
  const snapshotPath = await realpath(join(snapshotsDir, selected))
  return { snapshotPath, revision: selected, resolution: 'hf-cache' }
}

interface ModelConfigFacts {
  readonly maxPositionEmbeddings: number | null
  readonly modelType: string | null
  readonly quantization: unknown
}

function readModelConfigFacts(config: Record<string, unknown>): ModelConfigFacts {
  const nested = config.text_config as Record<string, unknown> | undefined
  const maxPosition = config.max_position_embeddings ?? nested?.max_position_embeddings ?? null
  return {
    maxPositionEmbeddings: typeof maxPosition === 'number' ? maxPosition : null,
    modelType: typeof config.model_type === 'string' ? config.model_type : null,
    quantization: config.quantization ?? null,
  }
}

/**
 * Verifies snapshot completeness and records file sizes/hashes. Weight shards (~6.3 GB) are
 * hashed only in measurement runs; dry-runs verify presence and size and hash every small
 * config/tokenizer file, so a dry-run stays fast beside concurrent measurement work.
 */
export async function verifySnapshot(
  resolved: {
    snapshotPath: string
    revision: string | null
    resolution: 'explicit-path' | 'hf-cache'
  },
  hfRepository: string,
  options: { readonly hashWeights: boolean },
): Promise<VerifiedSnapshot> {
  const { snapshotPath } = resolved
  const names = await readdir(snapshotPath)
  const missing = (name: string): never => {
    throw new Error(`Snapshot ${snapshotPath} is missing required file: ${name}`)
  }

  if (!names.includes('config.json')) missing('config.json')
  if (!names.includes('tokenizer_config.json')) missing('tokenizer_config.json')
  if (!names.includes('tokenizer.json') && !names.includes('tokenizer.model')) {
    missing('tokenizer.json (or tokenizer.model)')
  }
  const weightShards = names.filter((name) => name.endsWith('.safetensors')).sort()
  if (weightShards.length === 0) missing('*.safetensors')

  // If a shard index exists, every shard it names must be present — a partial snapshot fails closed.
  if (names.includes('model.safetensors.index.json')) {
    const index = JSON.parse(
      await readFile(join(snapshotPath, 'model.safetensors.index.json'), 'utf8'),
    ) as { weight_map?: Record<string, string> }
    const indexed = new Set(Object.values(index.weight_map ?? {}))
    for (const shard of indexed) {
      if (!names.includes(shard)) {
        throw new Error(`Snapshot index names a missing weight shard: ${shard}`)
      }
    }
  }

  const configFacts = readModelConfigFacts(
    JSON.parse(await readFile(join(snapshotPath, 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >,
  )

  const files: SnapshotFileRecord[] = []
  let totalSizeBytes = 0
  for (const name of [...names].sort()) {
    const path = join(snapshotPath, name)
    const fileStat = await stat(path)
    if (!fileStat.isFile()) continue
    totalSizeBytes += fileStat.size
    const isWeight = name.endsWith('.safetensors')
    const shouldHash = !isWeight ? fileStat.size <= SMALL_HASH_LIMIT_BYTES : options.hashWeights
    files.push({
      relativePath: name,
      sizeBytes: fileStat.size,
      sha256: shouldHash ? await sha256File(path) : null,
    })
  }

  return {
    snapshotPath,
    revision: resolved.revision,
    resolution: resolved.resolution,
    hfRepository,
    files,
    totalSizeBytes,
    maxPositionEmbeddings: configFacts.maxPositionEmbeddings,
    modelType: configFacts.modelType,
    quantization: configFacts.quantization,
    weightsHashed: options.hashWeights,
  }
}
