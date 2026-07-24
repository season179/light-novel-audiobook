import { open, rename } from 'node:fs/promises'
import { isAbsolute, posix, resolve } from 'node:path'

export function canonicalWorkspacePath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('workspace asset path must be a non-empty string')
  }
  if (
    value.includes('\\') ||
    value.includes('\0') ||
    isAbsolute(value) ||
    value.split('/').includes('..')
  ) {
    throw new Error('workspace asset path must be a relative POSIX path without traversal')
  }

  const normalized = posix.normalize(value)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('workspace asset path must remain below the workspace root')
  }
  return normalized
}

export function canonicalAbsoluteLinuxPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\\')) {
    throw new Error('runtime path must be an absolute Linux POSIX path')
  }
  return resolve(value)
}

export async function durableRename(source, destination) {
  const sourceHandle = await open(source, 'r')
  try {
    await sourceHandle.sync()
  } finally {
    await sourceHandle.close()
  }

  await rename(source, destination)
  const directoryHandle = await open(resolve(destination, '..'), 'r')
  try {
    await directoryHandle.sync()
  } finally {
    await directoryHandle.close()
  }
}

export async function atomicWriteJson(path, value) {
  const temporaryPath = `${path}.tmp-${process.pid}`
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await durableRename(temporaryPath, path)
}

export function readProcessIdentity(pid) {
  try {
    const stat = process.getBuiltinModule('node:fs').readFileSync(`/proc/${pid}/stat`, 'utf8')
    const closingParenthesis = stat.lastIndexOf(')')
    const fieldsAfterCommand = stat
      .slice(closingParenthesis + 2)
      .trim()
      .split(/\s+/)
    const startTimeTicks = fieldsAfterCommand[19]
    if (!startTimeTicks) return undefined
    return { pid, startTimeTicks }
  } catch {
    return undefined
  }
}

export function processRecordIsOwned(record) {
  const identity = readProcessIdentity(record.pid)
  return Boolean(identity && identity.startTimeTicks === record.startTimeTicks)
}
