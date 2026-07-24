import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalWorkspacePath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('workspace asset path must be a non-empty string')
  }
  if (
    value.includes('\\') ||
    value.includes('\0') ||
    isAbsolute(value) ||
    /^[a-z]:/i.test(value) ||
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

function assertContained(root, candidate) {
  const pathFromRoot = relative(root, candidate)
  if (
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${process.getBuiltinModule('node:path').sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error('workspace asset resolves outside the canonical workspace root')
  }
}

export function canonicalWorkspaceRoot(value) {
  const absolute = canonicalAbsoluteLinuxPath(value)
  const canonical = realpathSync(absolute)
  if (!statSync(canonical).isDirectory()) throw new Error('workspace root must be a directory')
  return canonical
}

export function resolveWorkspaceAsset(rootValue, relativeValue) {
  const root = canonicalWorkspaceRoot(rootValue)
  const workspacePath = canonicalWorkspacePath(relativeValue)
  const lexicalCandidate = resolve(root, workspacePath)
  assertContained(root, lexicalCandidate)

  let existingAncestor = lexicalCandidate
  const missingSegments = []
  while (!existsSync(existingAncestor)) {
    missingSegments.unshift(basename(existingAncestor))
    const parent = dirname(existingAncestor)
    if (parent === existingAncestor) throw new Error('workspace asset has no existing ancestor')
    existingAncestor = parent
  }

  const canonicalAncestor = realpathSync(existingAncestor)
  const resolvedCandidate = join(canonicalAncestor, ...missingSegments)
  assertContained(root, resolvedCandidate)
  if (existsSync(lexicalCandidate)) assertContained(root, realpathSync(lexicalCandidate))
  return resolvedCandidate
}

export function inspectFilesystem(value) {
  const canonical = realpathSync(value)
  const result = spawnSync(
    'findmnt',
    ['-J', '-T', canonical, '-o', 'TARGET,SOURCE,FSTYPE,OPTIONS'],
    {
      encoding: 'utf8',
    },
  )
  if (result.status !== 0) {
    throw new Error(`findmnt failed for filesystem verification: ${result.stderr || result.error}`)
  }
  const filesystem = JSON.parse(result.stdout).filesystems?.[0]
  if (!filesystem?.fstype) throw new Error('findmnt returned no filesystem')
  return {
    canonical,
    target: filesystem.target,
    source: filesystem.source,
    fstype: filesystem.fstype,
    options: filesystem.options,
  }
}

export function assertWslExt4Root(value) {
  const filesystem = inspectFilesystem(value)
  if (filesystem.fstype !== 'ext4') {
    throw new Error(`WSL ext4 probe root resolved to ${filesystem.fstype}, not ext4`)
  }
  return filesystem
}

export function assertMountedWindowsRoot(value) {
  const filesystem = inspectFilesystem(value)
  if (!/^\/mnt\/[a-z](?:\/|$)/i.test(filesystem.canonical)) {
    throw new Error('mounted-Windows probe root must be an explicit /mnt/<drive> path')
  }
  const isDrvFs =
    filesystem.fstype === 'drvfs' ||
    (filesystem.fstype === '9p' && /(?:^|,)aname=drvfs(?:;|,|$)/.test(filesystem.options))
  if (!isDrvFs || filesystem.fstype === 'ext4') {
    throw new Error(`mounted-Windows probe root is not DrvFS/9p: ${filesystem.fstype}`)
  }
  return filesystem
}

export async function durableRename(source, destination) {
  const sourceHandle = await open(source, 'r')
  try {
    await sourceHandle.sync()
  } finally {
    await sourceHandle.close()
  }

  await rename(source, destination)
  const directoryHandle = await open(dirname(destination), 'r')
  try {
    await directoryHandle.sync()
  } finally {
    await directoryHandle.close()
  }
}

export async function atomicWriteJson(path, value) {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await durableRename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export function readProcessIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const closingParenthesis = stat.lastIndexOf(')')
    const fieldsAfterCommand = stat
      .slice(closingParenthesis + 2)
      .trim()
      .split(/\s+/)
    const startTimeTicks = fieldsAfterCommand[19]
    if (!startTimeTicks) return undefined
    const executablePath = realpathSync(readlinkSync(`/proc/${pid}/exe`))
    const executableStat = statSync(executablePath)
    return {
      pid,
      startTimeTicks,
      executablePath,
      executableDevice: String(executableStat.dev),
      executableInode: String(executableStat.ino),
      commandLineSha256: sha256(readFileSync(`/proc/${pid}/cmdline`)),
    }
  } catch {
    return undefined
  }
}

export function processRecordIsOwned(record) {
  const identity = readProcessIdentity(record.pid)
  return Boolean(
    identity &&
      identity.startTimeTicks === record.startTimeTicks &&
      identity.executablePath === record.executablePath &&
      identity.executableDevice === record.executableDevice &&
      identity.executableInode === record.executableInode &&
      identity.commandLineSha256 === record.commandLineSha256,
  )
}
