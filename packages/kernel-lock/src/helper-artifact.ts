import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SOURCE_RELATIVE_PATH = 'packages/kernel-lock/native/darwin-held-lock.c'
const CONFIG_RELATIVE_PATH = 'config/kernel-lock-artifacts.json'
const COMPILE_ARGUMENTS = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror'] as const
const HEX_SHA256 = /^[0-9a-f]{64}$/u

interface ArtifactPin {
  readonly schemaVersion: 1
  readonly protocol: string
  readonly source: { readonly path: string; readonly sha256: string }
  readonly compileArguments: readonly string[]
}

interface LocalBuildManifest {
  readonly schemaVersion: 1
  readonly protocol: string
  readonly source: { readonly path: string; readonly sha256: string }
  readonly compiler: { readonly path: string; readonly identity: string }
  readonly compileArguments: readonly string[]
  readonly binary: { readonly path: string; readonly sha256: string }
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function findRepositoryRoot(startPath = process.cwd()): string {
  let candidate = resolve(startPath)
  for (;;) {
    if (
      existsSync(join(candidate, 'pnpm-workspace.yaml')) &&
      existsSync(join(candidate, CONFIG_RELATIVE_PATH))
    ) {
      return candidate
    }
    const parent = dirname(candidate)
    if (parent === candidate) {
      throw new Error(`Could not locate the repository root from ${resolve(startPath)}`)
    }
    candidate = parent
  }
}

export function darwinHelperSourcePath(repositoryRoot = findRepositoryRoot()): string {
  return join(repositoryRoot, SOURCE_RELATIVE_PATH)
}

export function darwinHelperPinPath(repositoryRoot = findRepositoryRoot()): string {
  return join(repositoryRoot, CONFIG_RELATIVE_PATH)
}

async function readPin(repositoryRoot: string): Promise<ArtifactPin> {
  const pin = JSON.parse(await readFile(darwinHelperPinPath(repositoryRoot), 'utf8')) as ArtifactPin
  if (
    pin.schemaVersion !== 1 ||
    typeof pin.protocol !== 'string' ||
    !HEX_SHA256.test(pin.source?.sha256 ?? '') ||
    pin.source.path !== SOURCE_RELATIVE_PATH ||
    JSON.stringify(pin.compileArguments) !== JSON.stringify(COMPILE_ARGUMENTS)
  ) {
    throw new Error('Darwin kernel-lock artifact pin is invalid')
  }
  const sourceHash = sha256(await readFile(darwinHelperSourcePath(repositoryRoot)))
  if (sourceHash !== pin.source.sha256) {
    throw new Error(
      `Darwin kernel-lock helper source hash drift: expected ${pin.source.sha256}, got ${sourceHash}`,
    )
  }
  return pin
}

function defaultArtifactDirectory(sourceSha256: string): string {
  return join(
    homedir(),
    '.local/share/light-novel-audiobook/tools/kernel-lock/darwin-arm64',
    sourceSha256,
  )
}

async function compilerIdentity(compiler: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(compiler, ['--version'], { encoding: 'utf8' })
  const identity = `${stdout}${stderr}`.trim()
  if (identity.length === 0) throw new Error('Darwin kernel-lock compiler identity is empty')
  return identity
}

async function build(
  pin: ArtifactPin,
  directory: string,
  compiler: string,
  repositoryRoot: string,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const suffix = `${process.pid}-${crypto.randomUUID()}`
  const temporaryBinary = join(directory, `.darwin-held-lock-${suffix}`)
  const temporaryManifest = join(directory, `.darwin-held-lock-manifest-${suffix}.json`)
  const binaryPath = join(directory, 'darwin-held-lock')
  const manifestPath = join(directory, 'manifest.json')
  try {
    await new Promise<void>((resolveBuild, rejectBuild) => {
      const child = spawn(
        compiler,
        [...COMPILE_ARGUMENTS, darwinHelperSourcePath(repositoryRoot), '-o', temporaryBinary],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-8_000)
      })
      child.once('error', rejectBuild)
      child.once('exit', (code) => {
        if (code === 0) resolveBuild()
        else
          rejectBuild(
            new Error(
              `Darwin kernel-lock helper compilation failed: ${stderr.trim() || `exit ${code}`}`,
            ),
          )
      })
    })
    await chmod(temporaryBinary, 0o700)
    const binaryHash = sha256(await readFile(temporaryBinary))
    const manifest: LocalBuildManifest = {
      schemaVersion: 1,
      protocol: pin.protocol,
      source: { path: pin.source.path, sha256: pin.source.sha256 },
      compiler: { path: compiler, identity: await compilerIdentity(compiler) },
      compileArguments: [...COMPILE_ARGUMENTS],
      binary: { path: binaryPath, sha256: binaryHash },
    }
    await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    await rename(temporaryBinary, binaryPath)
    await rename(temporaryManifest, manifestPath)
  } finally {
    await rm(temporaryBinary, { force: true })
    await rm(temporaryManifest, { force: true })
  }
}

async function verify(pin: ArtifactPin, directory: string): Promise<string> {
  const binaryPath = join(directory, 'darwin-held-lock')
  const manifestPath = join(directory, 'manifest.json')
  const [manifestDetails, binaryDetails] = await Promise.all([
    lstat(manifestPath),
    lstat(binaryPath),
  ])
  if (
    !manifestDetails.isFile() ||
    manifestDetails.isSymbolicLink() ||
    !binaryDetails.isFile() ||
    binaryDetails.isSymbolicLink() ||
    (binaryDetails.mode & 0o111) === 0
  ) {
    throw new Error('Darwin kernel-lock helper binary/manifest must be regular non-symlink files')
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as LocalBuildManifest
  const actualBinaryHash = sha256(await readFile(binaryPath))
  if (
    manifest.schemaVersion !== 1 ||
    manifest.protocol !== pin.protocol ||
    manifest.source?.path !== pin.source.path ||
    manifest.source.sha256 !== pin.source.sha256 ||
    typeof manifest.compiler?.path !== 'string' ||
    manifest.compiler.path.length === 0 ||
    typeof manifest.compiler.identity !== 'string' ||
    manifest.compiler.identity.length === 0 ||
    JSON.stringify(manifest.compileArguments) !== JSON.stringify(COMPILE_ARGUMENTS) ||
    resolve(manifest.binary?.path ?? '') !== resolve(binaryPath) ||
    !HEX_SHA256.test(manifest.binary?.sha256 ?? '') ||
    manifest.binary.sha256 !== actualBinaryHash
  ) {
    throw new Error('Darwin kernel-lock locally built binary manifest/hash verification failed')
  }
  return binaryPath
}

export interface ResolveDarwinHelperOptions {
  readonly artifactDirectory?: string
  readonly compiler?: string
  /** Defaults to the nearest ancestor containing the workspace and committed helper pin. */
  readonly repositoryRoot?: string
}

/** Builds outside Git when absent, then verifies source pin + local binary hash manifest every use. */
export async function resolveVerifiedDarwinHelper(
  options: ResolveDarwinHelperOptions = {},
): Promise<{ readonly path: string; readonly protocol: string }> {
  if (process.platform !== 'darwin') throw new Error('Darwin kernel-lock helper requires macOS')
  const repositoryRoot = findRepositoryRoot(options.repositoryRoot)
  const pin = await readPin(repositoryRoot)
  const directory = resolve(
    options.artifactDirectory ?? defaultArtifactDirectory(pin.source.sha256),
  )
  try {
    return { path: await verify(pin, directory), protocol: pin.protocol }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
  }
  await build(pin, directory, options.compiler ?? process.env.CC ?? '/usr/bin/cc', repositoryRoot)
  return { path: await verify(pin, directory), protocol: pin.protocol }
}
