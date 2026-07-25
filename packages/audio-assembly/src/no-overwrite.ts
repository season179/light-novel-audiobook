import { constants } from 'node:fs'
import { copyFile, link, stat, unlink } from 'node:fs/promises'
import { AudioAssemblyError, OutputExistsError } from './errors.js'

const errorCode = (error: unknown): string | null =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : null

export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw new AudioAssemblyError(`Could not inspect ${path}`, { cause: error })
  }
}

/** An existing reserved output is a hard error; assembly must never clobber a previous export. */
export const assertOutputAbsent = async (path: string): Promise<void> => {
  if (await pathExists(path)) throw new OutputExistsError(path)
}

export const assertOutputPresent = async (path: string, description: string): Promise<void> => {
  try {
    const stats = await stat(path)
    if (!stats.isFile() || stats.size === 0) {
      throw new AudioAssemblyError(`${description} was not written as a non-empty file: ${path}`)
    }
  } catch (error) {
    if (error instanceof AudioAssemblyError) throw error
    throw new AudioAssemblyError(`${description} was not produced: ${path}`, { cause: error })
  }
}

/**
 * Moves a staged file to its reserved path without ever overwriting. `link` and
 * `copyFile(COPYFILE_EXCL)` both fail with `EEXIST` if the destination appeared in the meantime, so
 * the check and the create are one atomic operation rather than a stat followed by a hopeful write.
 * `link` is tried first because it is instant; the copy is the cross-filesystem fallback.
 *
 * Removing the staged file is deliberately outside the link attempt. If it shared that `try`, an
 * `unlink` failure would be mistaken for a link failure, the copy fallback would then hit the
 * destination the link just created, and this run's own legitimate output would be reported as a
 * pre-existing one.
 */
export const claimOutputPath = async (stagedPath: string, finalPath: string): Promise<void> => {
  let linked = false
  try {
    await link(stagedPath, finalPath)
    linked = true
  } catch (error) {
    const code = errorCode(error)
    if (code === 'EEXIST') throw new OutputExistsError(finalPath)
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EMLINK' && code !== 'ENOSYS') {
      throw new AudioAssemblyError(`Could not place assembled output at ${finalPath}`, {
        cause: error,
      })
    }
  }

  if (!linked) {
    try {
      await copyFile(stagedPath, finalPath, constants.COPYFILE_EXCL)
    } catch (error) {
      if (errorCode(error) === 'EEXIST') throw new OutputExistsError(finalPath)
      throw new AudioAssemblyError(`Could not place assembled output at ${finalPath}`, {
        cause: error,
      })
    }
  }

  try {
    await unlink(stagedPath)
  } catch {
    // The output is already in place. A staged leftover is cleaned up with the staging directory.
  }
}

/** Removes outputs this run created, so a failed claim cannot leave a partial export behind. */
export const rollbackClaimedOutputs = async (paths: readonly string[]): Promise<void> => {
  for (const path of paths) {
    try {
      await unlink(path)
    } catch {
      // The rollback is best effort; the original failure is the error worth reporting.
    }
  }
}
