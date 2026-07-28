import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const manifestPath = join(repositoryRoot, 'config', 'ffmpeg-artifacts.json')
const workflowPath = join(repositoryRoot, '.github', 'workflows', 'ci.yml')

const HEX64 = /^[0-9a-f]{64}$/

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const workflow = readFileSync(workflowPath, 'utf8')

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
  assert.ok(Array.isArray(darwin.configureFlags) && darwin.configureFlags.length > 0)
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
