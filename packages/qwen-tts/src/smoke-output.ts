import { mkdir, readdir } from 'node:fs/promises'

/** Runs before engine construction/GPU lease acquisition; a smoke run never reuses or replaces. */
export async function prepareEmptySmokeOutputRoot(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const existing = await readdir(path)
  if (existing.length > 0) {
    throw new Error(
      'Real smoke output root must be empty before startup; existing canonical outputs are never replaced',
    )
  }
}
