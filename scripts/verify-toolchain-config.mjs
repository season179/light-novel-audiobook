#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const errors = []
const requiredCompilerOptions = [
  'strict',
  'noUncheckedIndexedAccess',
  'exactOptionalPropertyTypes',
  'useUnknownInCatchVariables',
]

function workspacePackages() {
  const workspaces = []
  for (const group of ['apps', 'packages']) {
    const groupPath = join(repositoryRoot, group)
    for (const entry of readdirSync(groupPath, { withFileTypes: true })) {
      const packagePath = join(groupPath, entry.name)
      const packageJsonPath = join(packagePath, 'package.json')
      if (entry.isDirectory() && existsSync(packageJsonPath)) {
        workspaces.push({ packagePath, packageJson: readJson(packageJsonPath) })
      }
    }
  }
  return workspaces.sort((left, right) => left.packagePath.localeCompare(right.packagePath))
}

function runWorkspaceTypeScript(packageName, args) {
  return spawnSync('pnpm', ['--filter', packageName, 'exec', 'tsc', ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
}

const packageJson = readJson(join(repositoryRoot, 'package.json'))
const biome = readJson(join(repositoryRoot, 'biome.json'))
const nativeTypeScript = packageJson.devDependencies?.['@typescript/native']
if (!/^npm:typescript@7(?:\.|$)/.test(nativeTypeScript ?? '')) {
  errors.push('@typescript/native must pin the TypeScript 7 native compiler')
}
if (packageJson.scripts?.typecheck?.includes('--if-present')) {
  errors.push('the root typecheck command must not hide workspaces with missing typecheck scripts')
}

const tscPath = join(repositoryRoot, 'node_modules', '.bin', 'tsc')
const tscResult = spawnSync(tscPath, ['--version'], { encoding: 'utf8' })
const rootTscVersion = tscResult.status === 0 ? tscResult.stdout.trim() : ''
if (!/^Version 7(?:\.|$)/.test(rootTscVersion)) {
  errors.push(
    tscResult.error
      ? `the normal tsc command is unavailable: ${tscResult.error.message}`
      : `the normal tsc command must be TypeScript 7; detected ${rootTscVersion || 'an unusable compiler'}`,
  )
}

const workspaces = workspacePackages()
if (workspaces.length === 0) errors.push('no apps/* or packages/* workspaces were found')
for (const { packagePath, packageJson: workspacePackage } of workspaces) {
  const packageName = workspacePackage.name ?? packagePath
  const typecheckScript = workspacePackage.scripts?.typecheck
  if (typeof typecheckScript !== 'string' || !/\btsc\b/.test(typecheckScript)) {
    errors.push(`${packageName} must define a typecheck script that invokes tsc`)
    continue
  }

  const versionResult = runWorkspaceTypeScript(packageName, ['--version'])
  const version = versionResult.status === 0 ? versionResult.stdout.trim() : ''
  if (!/^Version 7(?:\.|$)/.test(version)) {
    errors.push(`${packageName} resolves its tsc command to ${version || 'an unusable compiler'}`)
    continue
  }

  const tsconfigPath = join(packagePath, 'tsconfig.json')
  if (!existsSync(tsconfigPath)) {
    errors.push(`${packageName} is missing tsconfig.json`)
    continue
  }
  const configResult = runWorkspaceTypeScript(packageName, ['--showConfig', '-p', tsconfigPath])
  if (configResult.status !== 0) {
    errors.push(`${packageName} effective TypeScript configuration could not be read`)
    continue
  }

  let effectiveConfig
  try {
    effectiveConfig = JSON.parse(configResult.stdout)
  } catch {
    errors.push(`${packageName} returned invalid JSON from TypeScript --showConfig`)
    continue
  }
  for (const option of requiredCompilerOptions) {
    if (effectiveConfig.compilerOptions?.[option] !== true) {
      errors.push(`${packageName} must keep effective compilerOptions.${option} enabled`)
    }
  }
}

if (biome.formatter?.enabled !== true) errors.push('Biome formatter must remain enabled')
if (biome.linter?.enabled !== true) errors.push('Biome linter must remain enabled')
if (biome.assist?.actions?.source?.organizeImports !== 'on') {
  errors.push('Biome import organization must remain enabled')
}

if (errors.length > 0) {
  console.error('Toolchain configuration verification failed:')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(
    `${rootTscVersion}; strict TypeScript 7 verified for ${workspaces.length} workspaces; Biome enforcement verified.`,
  )
}
