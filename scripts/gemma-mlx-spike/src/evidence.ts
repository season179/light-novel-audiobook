import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Every reported measurement carries its collector and units; unlike quantities stay separate. */
export interface SpikeEvidence {
  readonly schema: 'gemma-mlx-spike-evidence@1'
  readonly issue: 106
  readonly phase: 'dry-run' | 'measurement' | 'cancellation'
  readonly result:
    | 'dry-run-ok'
    | 'client-gates-passed'
    | 'client-gates-failed'
    | 'cancelled-clean'
    | 'error'
  readonly startedAt: string
  readonly completedAt: string
  readonly [section: string]: unknown
}

export async function prepareOutDir(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true })
}

export async function writeEvidence(outDir: string, evidence: SpikeEvidence): Promise<string> {
  const path = join(outDir, 'gemma-mlx-spike-evidence.json')
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  return path
}
