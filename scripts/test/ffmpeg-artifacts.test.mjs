import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  configureFlagsSha256,
  createBuildSidecar,
  validateBuildSidecar,
  validateConfigureFlags,
  writeBuildSidecar,
} from '../ffmpeg-build-manifest.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const manifestPath = join(repositoryRoot, 'config', 'ffmpeg-artifacts.json')
const workflowPath = join(repositoryRoot, '.github', 'workflows', 'ci.yml')
const buildScriptPath = join(repositoryRoot, 'scripts', 'build-ffmpeg-macos.sh')
const helperPath = join(repositoryRoot, 'scripts', 'ffmpeg-build-manifest.mjs')

const HEX64 = /^[0-9a-f]{64}$/

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const workflow = readFileSync(workflowPath, 'utf8')

function writeMutationManifest(root, configureFlags) {
  mkdirSync(join(root, 'config'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  cpSync(helperPath, join(root, 'scripts', 'ffmpeg-build-manifest.mjs'))
  writeFileSync(
    join(root, 'config', 'ffmpeg-artifacts.json'),
    `${JSON.stringify({ version: manifest.version, builds: { 'darwin-arm64': { configureFlags } } })}\n`,
  )
}

function runFakeConfigure(configureFlags) {
  const root = mkdtempSync(join(tmpdir(), 'lna-ffmpeg-configure-'))
  try {
    writeMutationManifest(root, configureFlags)
    const sourceDirectory = join(root, 'source')
    const capturePath = join(root, 'configure-arguments.txt')
    mkdirSync(sourceDirectory)
    const fakeConfigure = join(sourceDirectory, 'configure')
    writeFileSync(fakeConfigure, '#!/bin/bash\nprintf \'%s\\n\' "$@" > "$FFMPEG_TEST_CAPTURE"\n')
    chmodSync(fakeConfigure, 0o755)

    const result = spawnSync(
      '/bin/bash',
      [
        '-c',
        'source "$1"; ffmpeg_configure_source "$2" "$3"',
        '_',
        buildScriptPath,
        sourceDirectory,
        root,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, FFMPEG_TEST_CAPTURE: capturePath },
      },
    )
    return {
      result,
      configureRan: existsSync(capturePath),
      arguments: existsSync(capturePath)
        ? readFileSync(capturePath, 'utf8').trimEnd().split('\n')
        : [],
    }
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}

function sidecarValues(root) {
  return {
    manifestPath: join(root, 'config', 'ffmpeg-artifacts.json'),
    version: manifest.version,
    platform: 'darwin/arm64',
    source: manifest.builds['darwin-arm64'].source,
    toolchain: {
      platform: 'darwin/arm64',
      macos: '26.5.2',
      xcode: 'Xcode "quoted"',
      appleClang: 'Apple clang \\ test',
      sdkPath: '/SDK Path/with spaces',
      sdkVersion: '26.5',
      make: 'GNU Make 3.81',
    },
    binaries: {
      ffmpeg: { path: '/tmp/quoted "ffmpeg"', sha256: 'a'.repeat(64) },
      ffprobe: { path: '/tmp/backslash\\ffprobe', sha256: 'b'.repeat(64) },
    },
  }
}

test('the manifest pins FFmpeg/ffprobe 7.0.2', () => {
  assert.equal(manifest.version, '7.0.2')
})

test('the linux-amd64 archive pin matches the Ubuntu CI lane exactly (no silent drift)', () => {
  const linux = manifest.builds['linux-amd64']
  assert.ok(linux, 'the linux-amd64 build entry must remain beside the darwin-arm64 entry')
  assert.match(linux.source.archiveSha256, HEX64)

  // The Ubuntu lane still reads this hash from its env var; the manifest must mirror it verbatim.
  const envMatch = workflow.match(/^\s*FFMPEG_ARCHIVE_SHA256:\s*([0-9a-f]{64})\s*$/m)
  assert.ok(envMatch, 'the Ubuntu lane must keep its FFMPEG_ARCHIVE_SHA256 env var')
  assert.equal(
    linux.source.archiveSha256,
    envMatch[1],
    'config/ffmpeg-artifacts.json and .github/workflows/ci.yml drifted apart for linux-amd64',
  )

  const urlMatch = workflow.match(/^\s*FFMPEG_ARCHIVE_URL:\s*(\S+)\s*$/m)
  assert.ok(urlMatch, 'the Ubuntu lane must keep its FFMPEG_ARCHIVE_URL env var')
  assert.equal(linux.source.url, urlMatch[1])
})

test('the darwin-arm64 entry pins the upstream source archive and a recorded reference build', () => {
  const darwin = manifest.builds['darwin-arm64']
  assert.ok(darwin, 'the darwin-arm64 build entry must exist')
  assert.equal(darwin.source.url, 'https://ffmpeg.org/releases/ffmpeg-7.0.2.tar.xz')
  assert.match(darwin.source.archiveSha256, HEX64)
  assert.equal(darwin.buildScript, 'scripts/build-ffmpeg-macos.sh')
  assert.deepEqual(validateConfigureFlags(darwin.configureFlags), darwin.configureFlags)
  assert.match(configureFlagsSha256(darwin.configureFlags), HEX64)
  assert.match(darwin.configureFlagsNote, /No --prefix.*copied directly/u)
  assert.match(darwin.configureFlagsNote, /--enable-static.*--disable-shared.*libav/u)
  assert.match(darwin.configureFlagsNote, /--disable-x86asm.*nasm\/yasm/u)
  assert.equal(
    darwin.referenceBuild.status,
    'recorded',
    'the reference build must be filled in, not left pending',
  )
  assert.match(darwin.referenceBuild.binaries.ffmpeg.sha256, HEX64)
  assert.match(darwin.referenceBuild.binaries.ffprobe.sha256, HEX64)
  assert.ok(
    darwin.toolchain.appleClang && darwin.toolchain.xcode && darwin.toolchain.sdkVersion,
    'the recorded toolchain must name the Apple clang, Xcode, and SDK that produced the binaries',
  )
})

test('the Bash 3.2 build path uses only the manifest ordered configure flags', () => {
  const baseline = manifest.builds['darwin-arm64'].configureFlags
  const variants = [
    ['--disable-everything'],
    [baseline[1], baseline[0], ...baseline.slice(2)],
    baseline.slice(0, -1),
    [...baseline, '--enable-small'],
  ]

  for (const configureFlags of variants) {
    const invocation = runFakeConfigure(configureFlags)
    assert.equal(invocation.result.status, 0, invocation.result.stderr)
    assert.equal(invocation.configureRan, true)
    assert.deepEqual(invocation.arguments, configureFlags)
  }

  const script = readFileSync(buildScriptPath, 'utf8')
  for (const flag of baseline) {
    assert.equal(script.includes(flag), false, `${flag} must not be duplicated in the Bash script`)
  }
  assert.equal(script.match(/\.\/configure/gu)?.length, 1)
  assert.deepEqual(script.match(/^ {4}\.\/configure .*$/gmu), [
    `    ./configure "\${configure_flags[@]}"`,
  ])
  assert.equal(script.match(/\bffmpeg_configure_source\b/gu)?.length, 2)
  assert.deepEqual(script.match(/^ {2}ffmpeg_configure_source .*$/gmu), [
    '  ffmpeg_configure_source "$source_dir" "$repository_root"',
  ])
})

test('source-pin loading surfaces explicit Node/JSON read failures', () => {
  const success = spawnSync(
    '/bin/bash',
    [
      '-c',
      'source "$1"; ffmpeg_load_source_pin "$2"; printf \'%s\\t%s\\t%s\\n\' "$FFMPEG_SOURCE_URL" "$FFMPEG_SOURCE_SHA" "$FFMPEG_SOURCE_VERSION"',
      '_',
      buildScriptPath,
      repositoryRoot,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(success.status, 0, success.stderr)
  assert.equal(
    success.stdout,
    `${manifest.builds['darwin-arm64'].source.url}\t${manifest.builds['darwin-arm64'].source.archiveSha256}\t${manifest.version}\n`,
  )

  const root = mkdtempSync(join(tmpdir(), 'lna-ffmpeg-source-pin-'))
  try {
    const emptyPath = join(root, 'bin')
    mkdirSync(emptyPath)
    symlinkSync('/usr/bin/mktemp', join(emptyPath, 'mktemp'))
    symlinkSync('/bin/rm', join(emptyPath, 'rm'))
    const missingNode = spawnSync(
      '/bin/bash',
      ['-c', 'source "$1"; ffmpeg_load_source_pin "$2"', '_', buildScriptPath, root],
      { encoding: 'utf8', env: { ...process.env, PATH: emptyPath } },
    )
    assert.notEqual(missingNode.status, 0)
    assert.match(
      missingNode.stderr,
      /could not read the darwin-arm64 source pin.*Node\.js or JSON read failed/,
    )

    mkdirSync(join(root, 'config'))
    writeFileSync(join(root, 'config', 'ffmpeg-artifacts.json'), '{ malformed json\n')
    const malformedJson = spawnSync(
      '/bin/bash',
      ['-c', 'source "$1"; ffmpeg_load_source_pin "$2"', '_', buildScriptPath, root],
      { encoding: 'utf8' },
    )
    assert.notEqual(malformedJson.status, 0)
    assert.match(malformedJson.stderr, /SyntaxError|Unexpected token/)
    assert.match(
      malformedJson.stderr,
      /could not read the darwin-arm64 source pin.*Node\.js or JSON read failed/,
    )
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

test('empty, duplicate, malformed, whitespace, newline, and NUL flags fail before configure', () => {
  const invalidValues = [
    [],
    'not-an-array',
    [''],
    ['enable-gpl'],
    ['--enable-gpl', '--enable-gpl'],
    ['--enable gpl'],
    ['--enable-gpl\n--disable-doc'],
    ['--enable-gpl\0'],
  ]

  for (const configureFlags of invalidValues) {
    assert.throws(() => validateConfigureFlags(configureFlags))
    const invocation = runFakeConfigure(configureFlags)
    assert.notEqual(invocation.result.status, 0)
    assert.equal(invocation.configureRan, false)
    assert.match(invocation.result.stderr, /configureFlags|configure flag/i)
  }
})

test('the JSON emitter records ordered flags and validates canonical hash drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'lna-ffmpeg-sidecar-'))
  try {
    writeMutationManifest(root, manifest.builds['darwin-arm64'].configureFlags)
    const values = sidecarValues(root)
    const sidecar = createBuildSidecar(values)
    assert.deepEqual(sidecar.configureFlags, manifest.builds['darwin-arm64'].configureFlags)
    assert.equal(
      sidecar.configureFlagsSha256,
      configureFlagsSha256(manifest.builds['darwin-arm64'].configureFlags),
    )
    assert.deepEqual(validateBuildSidecar(sidecar, sidecar.configureFlags), sidecar)

    const outputPath = join(root, '.ffmpeg-build-manifest.json.new')
    writeBuildSidecar(outputPath, values)
    assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), sidecar)

    const reordered = {
      ...sidecar,
      configureFlags: [
        sidecar.configureFlags[1],
        sidecar.configureFlags[0],
        ...sidecar.configureFlags.slice(2),
      ],
    }
    assert.throws(() => validateBuildSidecar(reordered), /configureFlagsSha256 drift/)
    assert.throws(
      () => validateBuildSidecar({ ...sidecar, configureFlagsSha256: '0'.repeat(64) }),
      /configureFlagsSha256 drift/,
    )
    assert.throws(
      () => validateBuildSidecar(sidecar, [...sidecar.configureFlags, '--enable-small']),
      /drifted from config\/ffmpeg-artifacts.json/,
    )
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})
