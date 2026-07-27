import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DirectorFidelityExhaustedError,
  type FidelityFinding,
  type FidelityRecoveryAttempt,
} from '@light-novel-audiobook/gemma-director'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { audioFileErrorResponse } from '../src/server/audio-file-response.js'
import type { AudiobookWebApi } from '../src/server/audiobook-web-api.js'
import { createAudiobookWebApi } from '../src/server/composition-root.js'
import { toPublicFailure, toWebApiResult, WebApiError } from '../src/server/errors.js'
import { FakeDirectorModel } from '../src/server/fakes/fake-director-model.js'
import { createRequestOriginPolicy } from '../src/server/request-origin-policy.js'
import { createStubEpubBytes } from './support/stub-epub.js'
import { createTestHarness, type TestHarness } from './support/test-harness.js'

/**
 * Regression for the MEDIUM findings on the error contract and the Host/Origin allowlist.
 */
let harness: TestHarness

describe('one error contract at every boundary', () => {
  beforeEach(async () => {
    harness = await createTestHarness()
  })

  afterEach(async () => {
    await harness.dispose()
    vi.restoreAllMocks()
  })

  it('returns unknown_job as a failure result rather than rejecting', async () => {
    const result = await harness.client.listChapterAudio({ jobId: 'job-does-not-exist' })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'unknown_job',
        message: expect.stringContaining('not in the local workspace'),
      },
    })
  })

  it('returns invalid_request for a blank identifier rather than a generic error', async () => {
    const { requireIdInput } = await import('../src/server/errors.js')
    const result = await toWebApiResult('getJobState', async () => requireIdInput('  ', 'Job ID'))

    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'Job ID is required.' },
    })
  })

  it('reports a missing job as a successful null read, not a failure', async () => {
    const result = await harness.client.getJobState({ jobId: 'job-000000000000000000000000' })

    expect(result).toEqual({ ok: true, value: null })
  })

  it('reports an invalid upload as a failure result with its code', async () => {
    const result = await harness.client.uploadEpub({
      file: new File([createStubEpubBytes()], 'notes.txt'),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('invalid_upload')
  })

  it('never returns an unexpected adapter message to the browser', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const leaky = new Error('SQLITE_CANTOPEN: /home/user/secret/path/jobs.db is locked')

    const failure = toPublicFailure(leaky, 'getJobState')

    expect(failure.code).toBe('internal')
    expect(failure.message).not.toContain('secret')
    expect(failure.message).not.toContain('SQLITE')
    expect(failure.message).not.toMatch(/log|diagnostic/i)
    // No job exists at this boundary, so there is no durable artifact path to promise.
    expect(logged).toHaveBeenCalledOnce()
    expect(String(logged.mock.calls[0]?.[1])).toContain('SQLITE_CANTOPEN')
  })

  it('keeps a WebApiError message, because this layer authored it', () => {
    const failure = toPublicFailure(
      new WebApiError('invalid_upload', 'Choose an EPUB file to upload.'),
      'uploadEpub',
    )

    expect(failure).toEqual({
      code: 'invalid_upload',
      message: 'Choose an EPUB file to upload.',
    })
  })

  it('sanitizes binary route failures too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const response = audioFileErrorResponse(new Error('ffmpeg died at /opt/models/secret'), 'route')

    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('secret')
  })
})

describe('Host and Origin allowlist', () => {
  const policy = createRequestOriginPolicy()

  const request = (headers: Record<string, string>) => ({
    headers: new Headers(headers),
    url: 'http://127.0.0.1:3000/',
  })

  it('allows the configured loopback hosts', () => {
    expect(policy.allowedHosts).toEqual(['localhost:3000', '127.0.0.1:3000'])
    expect(policy.isAllowed(request({ host: 'localhost:3000' }))).toBe(true)
    expect(policy.isAllowed(request({ host: '127.0.0.1:3000' }))).toBe(true)
  })

  it('refuses a rebound host that a same-origin CSRF check would accept', () => {
    expect(
      policy.isAllowed(
        request({
          host: 'evil.example',
          origin: 'http://evil.example',
          'sec-fetch-site': 'same-origin',
        }),
      ),
    ).toBe(false)
  })

  it('refuses a missing host and a foreign origin on an allowed host', () => {
    expect(policy.isAllowed(request({}))).toBe(false)
    expect(
      policy.isAllowed(request({ host: 'localhost:3000', origin: 'http://evil.example' })),
    ).toBe(false)
  })

  it('honours a configured origin list', () => {
    const configured = createRequestOriginPolicy('http://localhost:4100, http://127.0.0.1:4100')

    expect(configured.allowedHosts).toEqual(['localhost:4100', '127.0.0.1:4100'])
    expect(configured.isAllowed(request({ host: 'localhost:4100' }))).toBe(true)
    expect(configured.isAllowed(request({ host: 'localhost:3000' }))).toBe(false)
  })
})

/**
 * Regression for the round-2 MEDIUM: a failure raised asynchronously — an adapter factory, or an
 * adapter method during the run — used to be stored as its raw message and handed to the browser as
 * a successful job read, bypassing sanitization entirely.
 */
describe('asynchronous adapter failures are sanitized too', () => {
  let root: string
  let api: AudiobookWebApi

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lna-async-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('never returns a failing factory’s message to the browser', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const secret = 'MODEL_KEY_FAILURE at /home/user/private/model.gguf'
    api = await createAudiobookWebApi({
      workspaceRoot: root,
      createDirectorModel: () => {
        throw new Error(secret)
      },
    })

    const upload = await api.uploadEpub({
      fileName: 'async-failure.epub',
      bytes: createStubEpubBytes('async'),
    })
    const started = await api.startGeneration({ uploadId: upload.uploadId })

    const deadline = Date.now() + 10_000
    let job = started.job
    while (Date.now() < deadline) {
      const latest = await api.getJobState({ jobId: started.jobId })
      if (latest !== null) job = latest
      if (!job.active) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(job.state).toBe('failed')
    expect(job.error).toContain('The local server hit an unexpected error.')
    expect(job.failureDiagnosticPath).not.toBeNull()
    expect(job.error).toContain(job.failureDiagnosticPath as string)
    expect(job.error).not.toContain('Check the server log')
    expect(job.latestMessage).not.toContain('model.gguf')
    expect(JSON.stringify(job)).not.toContain('MODEL_KEY_FAILURE')
    // Console output remains secondary; the job now also points at the durable structured cause.
    expect(
      logged.mock.calls.some((call) =>
        call
          .map((argument) => String(argument))
          .join(' ')
          .includes(secret),
      ),
    ).toBe(true)
  })

  it('persists a nested real fidelity error while hashing passage text out of the artifact', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const sentinel = 'SENTINEL_STORY_PASSAGE_97_DO_NOT_PERSIST'
    const findings = [
      {
        code: 'text_substitution',
        sourcePassageId: 'passage-synthetic-0007',
        message: 'Model output substitutes or reorders immutable source text',
        source_text: sentinel,
      },
    ] as unknown as readonly FidelityFinding[]
    const attempts: readonly FidelityRecoveryAttempt[] = [
      {
        attemptNumber: 1,
        sampling: {
          seed: 41,
          temperature: 0.2,
          topP: 0.95,
          maxTokens: 2048,
          confidenceThreshold: 0.5,
        },
        requestSha256: '1'.repeat(64),
        rawOutputSha256: '2'.repeat(64),
        validatedOutputSha256: '3'.repeat(64),
        findingCodes: ['text_substitution'],
        sourcePassageIds: ['passage-synthetic-0007'],
      },
    ]
    const fidelity = new DirectorFidelityExhaustedError(findings, attempts)
    const invocation = new Error('Director invocation failed', { cause: fidelity })

    api = await createAudiobookWebApi({
      workspaceRoot: root,
      createDirectorModel: () =>
        new (class extends FakeDirectorModel {
          override async directChapter(): Promise<never> {
            throw invocation
          }
        })(),
    })
    const upload = await api.uploadEpub({
      fileName: 'structured-failure.epub',
      bytes: createStubEpubBytes('structured-failure'),
    })
    const started = await api.startGeneration({ uploadId: upload.uploadId })

    const deadline = performance.now() + 10_000
    let job = started.job
    while (performance.now() < deadline) {
      const latest = await api.getJobState({ jobId: started.jobId })
      if (latest !== null) job = latest
      if (!job.active) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(job.state).toBe('failed')
    expect(job.failureDiagnosticPath).not.toBeNull()
    expect(job.error).toContain(job.failureDiagnosticPath as string)
    const persisted = await readFile(job.failureDiagnosticPath as string, 'utf8')
    expect(persisted).not.toContain(sentinel)
    expect(persisted).toContain(createHash('sha256').update(sentinel, 'utf8').digest('hex'))
    const diagnostic = JSON.parse(persisted) as { error: Record<string, unknown> }
    expect(diagnostic.error).toMatchObject({
      kind: 'error',
      cause: {
        kind: 'error',
        message: 'Director invocation failed',
        cause: {
          kind: 'error',
          name: 'DirectorFidelityExhaustedError',
          findings: [
            {
              code: 'text_substitution',
              sourcePassageId: 'passage-synthetic-0007',
              source_text: {
                redacted: true,
                length: sentinel.length,
              },
            },
          ],
          attempts: [
            {
              attemptNumber: 1,
              sampling: { seed: 41, temperature: 0.2, topP: 0.95, maxTokens: 2048 },
              rawOutputSha256: '2'.repeat(64),
              findingCodes: ['text_substitution'],
              sourcePassageIds: ['passage-synthetic-0007'],
            },
          ],
        },
      },
    })
  })
})
