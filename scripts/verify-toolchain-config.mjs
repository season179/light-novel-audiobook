#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (relativePath) =>
  JSON.parse(readFileSync(join(repositoryRoot, relativePath), 'utf8'))

const packageJson = readJson('package.json')
const tsconfig = readJson('tsconfig.base.json')
const biome = readJson('biome.json')
const errors = []

const nativeTypeScript = packageJson.devDependencies?.['@typescript/native']
if (!/^npm:typescript@7(?:\.|$)/.test(nativeTypeScript ?? '')) {
  errors.push('@typescript/native must pin the TypeScript 7 native compiler')
}

const tscPath = join(repositoryRoot, 'node_modules', '.bin', 'tsc')
const tscResult = spawnSync(tscPath, ['--version'], { encoding: 'utf8' })
const tscVersion = tscResult.status === 0 ? tscResult.stdout.trim() : ''
if (!/^Version 7(?:\.|$)/.test(tscVersion)) {
  errors.push(
    tscResult.error
      ? `the normal tsc command is unavailable: ${tscResult.error.message}`
      : `the normal tsc command must be TypeScript 7; detected ${tscVersion || 'an unusable compiler'}`,
  )
}

const requiredCompilerOptions = [
  'strict',
  'noUncheckedIndexedAccess',
  'exactOptionalPropertyTypes',
  'useUnknownInCatchVariables',
]
for (const option of requiredCompilerOptions) {
  if (tsconfig.compilerOptions?.[option] !== true) {
    errors.push(`tsconfig.base.json must keep compilerOptions.${option} enabled`)
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
  console.log(`${tscVersion}; strict TypeScript and Biome enforcement verified.`)
}
