import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { readImplementationIdentity } from '../src'

const execFile = promisify(execFileCallback)
const packageUrl = new URL('../', import.meta.url)
const repositoryRoot = resolve(fileURLToPath(packageUrl), '../..')

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(relativePath, packageUrl), 'utf8')) as Record<
    string,
    unknown
  >
}

const spikeRoot = 'packages/llama-cpp-spike'
const spikeEvidenceRoot = `${spikeRoot}/evidence/`
const provenanceVerifier = `${spikeRoot}/test/evidence.test.ts`

async function gitOutput(repository: string, args: Array<string>): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd: repository })
  return stdout
}

async function verifierDiffSha256(
  repository: string,
  implementationCommit: string,
  currentRevision: string,
  path: string,
): Promise<string> {
  const patch = await gitOutput(repository, [
    'diff',
    '--no-renames',
    '--full-index',
    implementationCommit,
    currentRevision,
    '--',
    path,
  ])
  return createHash('sha256').update(patch).digest('hex')
}

async function readUnapprovedSpikeChanges(
  repository: string,
  implementationCommit: string,
  currentRevision: string,
  authorizedVerifierPatches: Record<string, string>,
): Promise<Array<string>> {
  const names = await gitOutput(repository, [
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    implementationCommit,
    currentRevision,
    '--',
    spikeRoot,
  ])
  const changes = names
    .split('\0')
    .filter(Boolean)
    .filter((path) => !path.startsWith(spikeEvidenceRoot))
  const unapproved = []
  for (const path of changes) {
    const expectedPatch = authorizedVerifierPatches[path]
    if (
      path !== provenanceVerifier ||
      !expectedPatch ||
      (await verifierDiffSha256(repository, implementationCommit, currentRevision, path)) !==
        expectedPatch
    ) {
      unapproved.push(path)
    }
  }
  return unapproved.sort()
}

describe('committed spike provenance and host evidence', () => {
  it('pins complete license and model revision chains with hashed sources', async () => {
    const provenance = await readJson('provenance.json')
    expect(provenance).toMatchObject({
      schemaVersion: 2,
      decision: 'go',
      tanstackAi: {
        license: {
          spdx: 'MIT',
          sha256: '9fe9970f409e5b1d2067c0107ac0201761d5fddc53e9b20b66619fb0d2b4122f',
        },
      },
      llamaCpp: {
        project: 'ggml-org/llama.cpp',
        commit: '555881ebc8b0fc0402b30e09258a32a7bfd13c52',
        license: {
          spdx: 'MIT',
          sha256: '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d',
        },
      },
      model: {
        quantization: {
          revision: '09816acd5d99df7be770d85ea30822623dab342c',
          sha256: '2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d',
          declaredLicense: 'Apache-2.0',
        },
        instructModel: {
          revision: '12fd25f77366fa6b3b4b768ec3050bf629380bac',
          declaredLicense: 'Apache-2.0',
        },
        baseModel: {
          revision: '93efa2f097d58c2a74874c7e644dbc9b0cee75a2',
          declaredLicense: 'Apache-2.0',
        },
        storedOutsideGit: true,
      },
    })
    const packages = (provenance.tanstackAi as { packages: Array<Record<string, unknown>> })
      .packages
    const currentLockfile = await readFile(resolve(repositoryRoot, 'pnpm-lock.yaml'), 'utf8')
    expect(packages.map((entry) => entry.name)).toEqual([
      '@tanstack/ai',
      '@tanstack/ai-openai',
      '@tanstack/ai-utils',
      '@tanstack/openai-base',
    ])
    for (const entry of packages) {
      expect(entry).toMatchObject({
        license: 'MIT',
        licenseFileSha256: '9fe9970f409e5b1d2067c0107ac0201761d5fddc53e9b20b66619fb0d2b4122f',
      })
      expect(entry.tarball).toMatch(/^https:\/\/registry\.npmjs\.org\//)
      expect(entry.integrity).toMatch(/^sha512-/)
      const packageKey = `${entry.name as string}@${entry.version as string}`.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
      )
      const integrity = (entry.integrity as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      expect(currentLockfile).toMatch(
        new RegExp(`  '${packageKey}':\\n    resolution: \\{integrity: ${integrity}\\}`),
      )
    }
  })

  it('recomputes the canonical implementation source identity in CI', async () => {
    const evidence = await readJson('evidence/real-host-run.json')
    const git = evidence.git as {
      implementationCommit: string
      implementationTree: string
      canonicalSourceSetSha256: string
      sourceFiles: Array<string>
    }
    await execFile('git', ['merge-base', '--is-ancestor', git.implementationCommit, 'HEAD'], {
      cwd: repositoryRoot,
    })
    const recorded = await readImplementationIdentity(repositoryRoot, git.implementationCommit)
    expect(recorded).toEqual({
      commit: git.implementationCommit,
      tree: git.implementationTree,
      canonicalSourceSetSha256: git.canonicalSourceSetSha256,
      sourceFiles: git.sourceFiles,
    })
    const guard = JSON.parse(
      await readFile(resolve(repositoryRoot, 'config/issue-5-evidence-guard.json'), 'utf8'),
    ) as {
      schemaVersion: number
      implementationCommit: string
      authorizedVerifierPatches: Record<string, string>
    }
    expect(guard).toMatchObject({
      schemaVersion: 1,
      implementationCommit: git.implementationCommit,
    })
    expect(
      await readUnapprovedSpikeChanges(
        repositoryRoot,
        git.implementationCommit,
        'HEAD',
        guard.authorizedVerifierPatches,
      ),
    ).toEqual([])
    expect(git.sourceFiles).toEqual(
      expect.arrayContaining([
        'packages/llama-cpp-spike/src/client.ts',
        'packages/llama-cpp-spike/src/config.ts',
        'packages/llama-cpp-spike/src/schema.ts',
        'packages/llama-cpp-spike/src/errors.ts',
        'packages/llama-cpp-spike/src/slot-pool.ts',
        'packages/llama-cpp-spike/scripts/real-host-smoke.ts',
        'packages/llama-cpp-spike/scripts/host-runtime-safety.ts',
        'packages/llama-cpp-spike/scripts/prepare-host.sh',
        'packages/llama-cpp-spike/package.json',
        'packages/llama-cpp-spike/provenance.json',
        'pnpm-lock.yaml',
      ]),
    )
  })

  it('allows unrelated additions and evidence commits but rejects spike source edits', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'llama-spike-evidence-guard-'))
    const sourcePath = join(repository, spikeRoot, 'src/client.ts')
    const evidencePath = join(repository, spikeEvidenceRoot, 'run.json')
    const verifierPath = join(repository, provenanceVerifier)
    const commit = async (message: string) => {
      await gitOutput(repository, ['add', '.'])
      await gitOutput(repository, ['commit', '-m', message])
      return (await gitOutput(repository, ['rev-parse', 'HEAD'])).trim()
    }
    try {
      await gitOutput(repository, ['init'])
      await gitOutput(repository, ['config', 'user.name', 'Fixture'])
      await gitOutput(repository, ['config', 'user.email', 'fixture@example.invalid'])
      await Promise.all([
        mkdir(dirname(sourcePath), { recursive: true }),
        mkdir(dirname(evidencePath), { recursive: true }),
        mkdir(dirname(verifierPath), { recursive: true }),
      ])
      await writeFile(sourcePath, 'export const value = 1\n')
      await writeFile(evidencePath, '{"run":1}\n')
      await writeFile(verifierPath, 'export const verifier = 1\n')
      const implementationCommit = await commit('implementation')

      await mkdir(join(repository, 'packages/unrelated'), { recursive: true })
      await writeFile(join(repository, 'package.json'), '{"private":true}\n')
      await writeFile(join(repository, 'packages/unrelated/index.ts'), 'export {}\n')
      await writeFile(evidencePath, '{"run":2}\n')
      await writeFile(verifierPath, 'export const verifier = 2\n')
      const allowedCommit = await commit('unrelated and evidence changes')
      const authorization = {
        [provenanceVerifier]: await verifierDiffSha256(
          repository,
          implementationCommit,
          allowedCommit,
          provenanceVerifier,
        ),
      }
      expect(
        await readUnapprovedSpikeChanges(
          repository,
          implementationCommit,
          allowedCommit,
          authorization,
        ),
      ).toEqual([])

      await writeFile(sourcePath, 'export const value = 2\n')
      const sourceEdit = await commit('spike source edit')
      expect(
        await readUnapprovedSpikeChanges(
          repository,
          implementationCommit,
          sourceEdit,
          authorization,
        ),
      ).toContain(`${spikeRoot}/src/client.ts`)

      await gitOutput(repository, ['reset', '--hard', allowedCommit])
      await writeFile(verifierPath, 'export const verifier = 3\n')
      const verifierEdit = await commit('unapproved verifier edit')
      expect(
        await readUnapprovedSpikeChanges(
          repository,
          implementationCommit,
          verifierEdit,
          authorization,
        ),
      ).toContain(provenanceVerifier)
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })

  it('keeps real evidence sanitized and proves auth, exact request forwarding, deadlines, and cleanup', async () => {
    const evidence = await readJson('evidence/real-host-run.json')
    expect(evidence).toMatchObject({
      schemaVersion: 2,
      decision: 'go',
      endpoint: {
        host: '127.0.0.1',
        productionDefault: 'http://127.0.0.1:8080/v1',
      },
      listener: { loopbackOnly: true },
      runtime: {
        cleanSourceCheckout: true,
        cleanRebuild: true,
        ext4: true,
        externalRootProof: {
          canonicalized: true,
          ext4: true,
          outsideWorktree: true,
          outsideRepository: true,
          outsideGitDirectory: true,
          overlapCheckedBothDirections: true,
          symlinkComponentsRejected: true,
          validatedPathClasses: expect.arrayContaining([
            'binary',
            'license',
            'manifest',
            'model',
            'runtime',
            'source',
            'temporary',
          ]),
        },
      },
      security: {
        apiKey: {
          randomPerRun: true,
          fileMode0600: true,
          serverSideOnly: true,
          capturedAuthorization: 'redacted',
          logged: false,
          committed: false,
        },
        browserBoundary: {
          apiKeySent: false,
          options: { slotObservedBusy: false, accessControlAllowOrigin: null },
          posts: { statuses: [401], slotObservedBusy: false, inferenceAuthorized: false },
          finalSlotIdle: true,
        },
      },
      structuredOutput: { jsonSchemaReachedServer: true, schemaValid: true },
      requestShape: {
        boundary: 'loopback-transparent-fetch',
        forwardedToRealBackend: '/v1/chat/completions',
        authorization: { present: true, scheme: 'Bearer', redacted: true },
        backendStatus: 200,
        observed: {
          model: 'smollm2-135m-instruct-q4-k-m',
          temperature: 0,
          seed: 5,
          maxTokens: 64,
          stream: true,
          streamOptions: { include_usage: true },
          responseFormat: { type: 'json_schema', strict: true },
        },
      },
      cancellation: {
        requestReachedServer: true,
        classifiedAs: 'cancelled',
        serverSlotReleased: true,
        clientSlotReleased: true,
        followUpSucceeded: true,
      },
      timeout: {
        requestReachedServer: true,
        classifiedAs: 'timeout',
        serverSlotReleased: true,
        clientSlotReleased: true,
        followUpSucceeded: true,
      },
      cleanup: {
        portReleased: true,
        apiKeyFileRemoved: true,
        logsDisabled: true,
        resourcesClosed: true,
      },
    })
    const runtime = evidence.runtime as { binarySha256: string }
    const requestShape = evidence.requestShape as {
      bodySha256: string
      forwardedBodySha256: string
    }
    expect(runtime.binarySha256).toMatch(/^[0-9a-f]{64}$/)
    expect(requestShape.bodySha256).toMatch(/^[0-9a-f]{64}$/)
    expect(requestShape.forwardedBodySha256).toBe(requestShape.bodySha256)

    const serialized = JSON.stringify(evidence)
    expect(serialized).not.toMatch(/\/home\/|\/mnt\/|[A-Z]:\\/)
    expect(serialized).not.toMatch(/"(?:apiKeyValue|token|pid|rawPrompt|rawResponse|logPath)"/i)
    expect(serialized).not.toContain('fixture-server-side-key')
  })
})
