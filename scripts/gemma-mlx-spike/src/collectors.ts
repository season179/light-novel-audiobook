import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface Metric {
  readonly value: number | string | boolean | null
  readonly collector: string
  readonly units: string
  readonly note?: string
}

export function metric(
  value: number | string | boolean | null,
  collector: string,
  units: string,
  note?: string,
): Metric {
  return {
    value,
    collector,
    units,
    ...(note === undefined ? {} : { note }),
  }
}

export async function portIsFree(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const server = createServer()
    server.once('error', () => resolvePromise(false))
    server.listen(port, host, () => {
      server.close((error) => resolvePromise(error === undefined))
    })
  })
}

export async function waitForPortFree(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const startedAt = performance.now()
  while (performance.now() - startedAt < timeoutMs) {
    if (await portIsFree(host, port)) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  return false
}

async function commandOutput(
  command: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, [...args], { timeout: 30_000 })
    return stdout
  } catch {
    return null
  }
}

async function sysctlNumber(key: string): Promise<number | null> {
  const output = await commandOutput('sysctl', ['-n', key])
  if (output === null) return null
  const parsed = Number(output.trim())
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * The host's Metal recommended maximum working set, measured through the actual Metal API.
 * `iogpu.wired_limit_mb` is 0 on Apple Silicon, so the auditable collector is a one-shot Swift
 * query of MTLCreateSystemDefaultDevice().recommendedMaxWorkingSetSize — the same property the
 * MLX server process would see. Unavailable (not estimated) when Swift or Metal is absent.
 */
async function queryRecommendedMaxWorkingSetSize(): Promise<number | null> {
  const output = await commandOutput('swift', [
    '-e',
    'import Metal; if let d = MTLCreateSystemDefaultDevice() { print(d.recommendedMaxWorkingSetSize) }',
  ])
  if (output === null) return null
  const parsed = Number(output.trim())
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

async function queryMemoryPressurePercent(): Promise<number | null> {
  const output = await commandOutput('memory_pressure', ['-Q'])
  if (output === null) return null
  const match = /(\d+)\s*%/.exec(output)
  return match?.[1] === undefined ? null : Number(match[1])
}

export interface HostMemoryFacts {
  readonly physicalMemoryBytes: Metric
  readonly recommendedMaxWorkingSetBytes: Metric
  readonly memoryPressureFreePercent: Metric
}

export async function collectHostMemoryFacts(): Promise<HostMemoryFacts> {
  const [physical, recommended, pressure] = await Promise.all([
    sysctlNumber('hw.memsize'),
    queryRecommendedMaxWorkingSetSize(),
    queryMemoryPressurePercent(),
  ])
  return {
    physicalMemoryBytes: metric(physical, 'sysctl -n hw.memsize', 'bytes'),
    recommendedMaxWorkingSetBytes: metric(
      recommended,
      'swift -e MTLCreateSystemDefaultDevice().recommendedMaxWorkingSetSize',
      'bytes',
      recommended === null
        ? 'unavailable on this host; not estimated'
        : 'Metal API value for the default device, identical to what the MLX server process sees',
    ),
    memoryPressureFreePercent: metric(
      pressure,
      'memory_pressure -Q (system-wide memory free percentage)',
      'percent',
    ),
  }
}

export interface ProcessFamilySnapshot {
  readonly pids: readonly number[]
  readonly rssBytes: number
}

/**
 * Sums resident memory for the owned server process family by walking the ppid table from
 * `ps`. RSS is process memory only — it is never labeled as per-process Metal allocation.
 */
export async function processFamilySnapshot(rootPid: number): Promise<ProcessFamilySnapshot> {
  const output = await commandOutput('ps', ['-axo', 'pid=,ppid=,rss='])
  if (output === null) return { pids: [], rssBytes: 0 }
  const childrenByParent = new Map<number, Array<{ pid: number; rssKb: number }>>()
  const rssByPid = new Map<number, number>()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    const rssKb = Number(match[3])
    rssByPid.set(pid, rssKb)
    const siblings = childrenByParent.get(ppid) ?? []
    siblings.push({ pid, rssKb })
    childrenByParent.set(ppid, siblings)
  }
  if (!rssByPid.has(rootPid)) return { pids: [], rssBytes: 0 }
  const pids: number[] = []
  let rssKb = 0
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift() as number
    pids.push(pid)
    rssKb += rssByPid.get(pid) ?? 0
    for (const child of childrenByParent.get(pid) ?? []) queue.push(child.pid)
  }
  return { pids, rssBytes: rssKb * 1024 }
}

export interface RssPeak {
  readonly rssBytes: number
  readonly familyPids: readonly number[]
  readonly observedAtMonotonicMs: number
  readonly samples: number
}

/** Polls the owned process family's RSS; keeps only the peak and its provenance. */
export class RssSampler {
  readonly #rootPid: number
  readonly #intervalMs: number
  readonly #startedAt = performance.now()
  #timer: NodeJS.Timeout | undefined
  #sampling = false
  #peak: RssPeak = { rssBytes: 0, familyPids: [], observedAtMonotonicMs: 0, samples: 0 }

  constructor(rootPid: number, intervalMs = 250) {
    this.#rootPid = rootPid
    this.#intervalMs = intervalMs
  }

  start(): void {
    const tick = async (): Promise<void> => {
      if (this.#sampling) return
      this.#sampling = true
      try {
        await this.sample()
      } finally {
        this.#sampling = false
      }
    }
    void tick()
    this.#timer = setInterval(() => void tick(), this.#intervalMs)
    this.#timer.unref()
  }

  /** One explicit sample; used for a final observation after the process exits. */
  async sample(): Promise<void> {
    const snapshot = await processFamilySnapshot(this.#rootPid)
    const samples = this.#peak.samples + 1
    if (snapshot.rssBytes >= this.#peak.rssBytes) {
      this.#peak = {
        rssBytes: snapshot.rssBytes,
        familyPids: snapshot.pids,
        observedAtMonotonicMs: Math.round(performance.now() - this.#startedAt),
        samples,
      }
    } else {
      this.#peak = { ...this.#peak, samples }
    }
  }

  get peak(): RssPeak {
    return this.#peak
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
  }
}
