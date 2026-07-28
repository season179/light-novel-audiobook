import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface ServerBinFacts {
  readonly configuredPath: string
  readonly realPath: string
  readonly sha256: string
  readonly shebang: string | null
}

export interface PythonPackageIdentity {
  readonly name: string
  readonly version: string
}

export interface MlxRuntimeIdentity {
  readonly pythonTag: string | null
  readonly packages: readonly PythonPackageIdentity[]
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Resolves the mlx_lm.server executable without executing it. */
export async function findServerBin(configured: string | undefined): Promise<string> {
  if (configured !== undefined) {
    await access(configured, constants.X_OK).catch(() => {
      throw new Error(`--server-bin is not executable: ${configured}`)
    })
    return configured
  }
  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(':')) {
    if (dir.length === 0) continue
    const candidate = join(dir, 'mlx_lm.server')
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Keep searching PATH.
    }
  }
  throw new Error('mlx_lm.server not found on PATH; pass --server-bin')
}

export async function serverBinFacts(configured: string | undefined): Promise<ServerBinFacts> {
  const configuredPath = await findServerBin(configured)
  const realPath = await realpath(configuredPath)
  const [sha256, head] = await Promise.all([
    sha256File(realPath),
    readFile(realPath, 'utf8').then((text) => text.slice(0, 256)),
  ])
  const shebang = head.startsWith('#!') ? (head.split('\n')[0] ?? null) : null
  return { configuredPath, realPath, sha256, shebang }
}

/**
 * Reads the mlx-lm environment identity from the installation's dist-info metadata — file reads
 * only, never execution. Works for the uv-tool layout (<tool>/lib/pythonX.Y/site-packages) the
 * shebang points into; records what is found and nulls what is not, never guesses.
 */
export async function mlxRuntimeIdentity(serverBinRealPath: string): Promise<MlxRuntimeIdentity> {
  // <env>/bin/mlx_lm.server -> <env>/lib/pythonX.Y/site-packages
  const envRoot = resolve(dirname(serverBinRealPath), '..')
  const libDir = join(envRoot, 'lib')
  const pythonTags = await readdir(libDir).catch(() => [] as string[])
  const pythonTag = pythonTags.find((entry) => /^python\d+\.\d+$/.test(entry)) ?? null
  if (pythonTag === null) return { pythonTag: null, packages: [] }
  const sitePackages = join(libDir, pythonTag, 'site-packages')
  const entries = await readdir(sitePackages).catch(() => [] as string[])
  const wanted = new Map([
    ['mlx_lm', 'mlx-lm'],
    ['mlx', 'mlx'],
    ['mlx_metal', 'mlx-metal'],
  ])
  const packages: PythonPackageIdentity[] = []
  for (const entry of entries) {
    const match = /^([a-z0-9_]+)-(.+)\.dist-info$/.exec(entry)
    if (match === null) continue
    const distName = wanted.get(match[1] ?? '')
    if (distName === undefined) continue
    const metadata = await readFile(join(sitePackages, entry, 'METADATA'), 'utf8').catch(() => '')
    const version = /^Version:\s*(.+)$/m.exec(metadata)?.[1]?.trim()
    if (version !== undefined) packages.push({ name: distName, version })
  }
  packages.sort((left, right) => (left.name < right.name ? -1 : 1))
  return { pythonTag, packages }
}

export async function fileExistsExecutable(path: string): Promise<boolean> {
  try {
    const fileStat = await stat(path)
    return fileStat.isFile() && (fileStat.mode & 0o111) !== 0
  } catch {
    return false
  }
}
