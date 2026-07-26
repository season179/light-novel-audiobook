import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DomainEpubExtractor } from '../../packages/epub-ingestion/src/index.js'
import { artifactSnapshotUnchanged, assertMidRenderStop, verifyOutput } from '../proof-m1.mjs'
import { assertContainerProbe, ContainerCheckFailure } from '../proof-m1-container-check.mjs'
import { HarnessFailure, runChecked } from '../proof-m1-lib.mjs'

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    })
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const riff = (lastByte: number): Buffer =>
  Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([5, 0, 0, 0]),
    Buffer.from('WAVE', 'ascii'),
    Buffer.from([lastByte]),
  ])

const outputFixture = async (downloadBytes: Buffer) => {
  const root = await mkdtemp(path.join(tmpdir(), 'lna-proof-output-'))
  roots.push(root)
  const workspaceBytes = riff(1)
  const m4bPath = path.join(root, 'fixture-v001.m4b')
  await writeFile(m4bPath, workspaceBytes)

  const chapterBytes = riff(2)
  const server = createServer((request, response) => {
    const bytes = request.url === '/chapter' ? chapterBytes : downloadBytes
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.end(bytes)
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server has no port')

  const listing = {
    ready: true,
    chapters: [
      {
        chapterId: 'book-fixture-ch0001',
        chapterLabel: 'Chapter 1',
        audioUrl: '/chapter',
      },
    ],
    download: { url: '/download', fileName: path.basename(m4bPath) },
  }
  const client = {
    call: async (name: string) => {
      if (name !== 'listChapterAudioFn') throw new Error(`unexpected call ${name}`)
      return listing
    },
  }
  const config = { workspace: root, transports: 'fake', expectedChapters: 1 }
  return {
    config,
    client,
    baseUrl: `http://127.0.0.1:${address.port}`,
    workspaceBytes,
  }
}

const validProbe = () => ({
  streams: [
    { codec_type: 'audio', codec_name: 'aac' },
    { codec_type: 'video', disposition: { attached_pic: 1 } },
  ],
  chapters: [
    { start_time: '0', end_time: '1' },
    { start_time: '1', end_time: '2' },
  ],
  format: {
    duration: '2',
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    tags: { title: 'Synthetic fixture', artist: 'Fixture creator' },
  },
})

const containerExpectations = { expectedChapters: 2, expectCover: true, expectCreator: true }

const requiredFixtureValue = <Value>(value: Value | undefined): Value => {
  if (value === undefined) throw new Error('test fixture value is missing')
  return value
}

describe('proof-m1 checked subprocesses', () => {
  it('returns stdout only after a zero exit', () => {
    expect(
      runChecked(process.execPath, ['-e', "process.stdout.write('ok')"], 'success probe'),
    ).toBe('ok')
  })

  it('rejects a nonzero exit instead of treating its stdout as evidence', () => {
    expect(() =>
      runChecked(
        process.execPath,
        ['-e', "process.stdout.write('misleading output'); process.exit(7)"],
        'failure probe',
      ),
    ).toThrow(HarnessFailure)
  })
})

describe('proof-m1 output assertions', () => {
  it('accepts the exact workspace M4B returned by the download route', async () => {
    const fixture = await outputFixture(riff(1))

    const output = await verifyOutput(
      fixture.config,
      fixture.client,
      'job-output-proof',
      fixture.baseUrl,
    )

    expect(output.m4b.sha256).toBe(
      createHash('sha256').update(fixture.workspaceBytes).digest('hex'),
    )
  })

  it('rejects a different but independently valid-looking download payload', async () => {
    const fixture = await outputFixture(riff(9))

    await expect(
      verifyOutput(fixture.config, fixture.client, 'job-output-proof', fixture.baseUrl),
    ).rejects.toThrow('the downloaded M4B is not the workspace M4B')
  })
})

describe('proof-m1 container assertions reject vacuous and adjacent evidence', () => {
  it('accepts a complete AAC container projection', () => {
    expect(assertContainerProbe(validProbe(), containerExpectations)).toMatchObject({
      codec: 'aac',
      durationMs: 2_000,
      chapterMarkers: 2,
      markerSpansOrdered: true,
      coverEmbedded: true,
      titlePresent: true,
      creatorPresent: true,
    })
  })

  it.each([
    {
      name: 'missing container duration',
      change: (probe: ReturnType<typeof validProbe>) => {
        probe.format.duration = undefined as unknown as string
      },
    },
    {
      name: 'missing marker end',
      change: (probe: ReturnType<typeof validProbe>) => {
        requiredFixtureValue(probe.chapters[1]).end_time = undefined as unknown as string
      },
    },
    {
      name: 'gap between markers',
      change: (probe: ReturnType<typeof validProbe>) => {
        requiredFixtureValue(probe.chapters[1]).start_time = '1.25'
      },
    },
    {
      name: 'wrong codec',
      change: (probe: ReturnType<typeof validProbe>) => {
        requiredFixtureValue(probe.streams[0]).codec_name = 'mp3'
      },
    },
    {
      name: 'missing cover stream',
      change: (probe: ReturnType<typeof validProbe>) => {
        probe.streams.splice(1, 1)
      },
    },
    {
      name: 'blank title',
      change: (probe: ReturnType<typeof validProbe>) => {
        probe.format.tags.title = ' '
      },
    },
    {
      name: 'blank creator',
      change: (probe: ReturnType<typeof validProbe>) => {
        probe.format.tags.artist = ' '
      },
    },
  ])('rejects $name', ({ change }) => {
    const probe = validProbe()
    change(probe)
    expect(() => assertContainerProbe(probe, containerExpectations)).toThrow(ContainerCheckFailure)
  })

  it('rejects a zero expected-marker count rather than proving an empty set', () => {
    expect(() =>
      assertContainerProbe(
        {
          streams: [{ codec_type: 'audio', codec_name: 'aac' }],
          chapters: [],
          format: { duration: '0', tags: { title: 'Empty fixture' } },
        },
        { expectedChapters: 0, expectCover: false, expectCreator: false },
      ),
    ).toThrow('expected chapter count must be positive')
  })
})

describe('proof-m1 restart assertions', () => {
  it('accepts a genuinely partial stop', () => {
    expect(() => assertMidRenderStop(1, 2)).not.toThrow()
  })

  it.each([
    { name: 'zero completed segments', completed: 0, total: 2, message: 'nothing to reuse' },
    { name: 'all segments completed', completed: 2, total: 2, message: 'not a mid-render stop' },
    {
      name: 'a NaN completed count',
      completed: Number.NaN,
      total: 2,
      message: 'invalid segment counts',
    },
  ])('rejects $name', ({ completed, total, message }) => {
    expect(() => assertMidRenderStop(completed, total)).toThrow(message)
  })

  it('requires both bytes and mtime to remain unchanged', () => {
    const before = { sha256: 'a'.repeat(64), mtimeMs: 10 }
    expect(artifactSnapshotUnchanged(before, { ...before })).toBe(true)
    expect(artifactSnapshotUnchanged(before, { ...before, mtimeMs: 11 })).toBe(false)
    expect(artifactSnapshotUnchanged(before, { ...before, sha256: 'b'.repeat(64) })).toBe(false)
  })
})

describe('committed real acceptance evidence is non-vacuous and fixture-bound', () => {
  it('ties the recorded counts to the committed EPUB and to independent run effects', async () => {
    const evidence = JSON.parse(
      await readFile(
        path.join(REPOSITORY_ROOT, 'docs/evidence/issue-21-m1-proof-real.json'),
        'utf8',
      ),
    )
    const epubPath = path.join(REPOSITORY_ROOT, 'tests/fixtures/epub/acceptance-m1.epub')
    const epubBytes = await readFile(epubPath)
    expect(evidence.schema).toBe('issue-21-m1-proof@1')
    expect(evidence.mode).toBe('real')
    expect(evidence.epub.bytes).toBe(epubBytes.byteLength)
    expect(evidence.epub.sha256).toBe(createHash('sha256').update(epubBytes).digest('hex'))

    const extractionRoot = await mkdtemp(path.join(tmpdir(), 'lna-proof-evidence-extract-'))
    roots.push(extractionRoot)
    const extracted = await new DomainEpubExtractor({
      workspaceRoot: extractionRoot,
      repositoryRoot: REPOSITORY_ROOT,
    }).extract({ epubPath })
    const extractedPassages = extracted.chapters.reduce(
      (count, chapter) => count + chapter.sourcePassages.length,
      0,
    )
    expect(extractedPassages).toBeGreaterThan(0)
    expect(evidence.counts.passages).toBe(extractedPassages)

    expect(evidence.restart.segmentsCompletedAtStop).toBeGreaterThan(0)
    expect(evidence.restart.segmentsCompletedAtStop).toBeLessThan(evidence.restart.totalSegments)
    expect(evidence.restart.segmentsReused).toBe(evidence.restart.segmentsCompletedAtStop)
    expect(evidence.restart.segmentsReused + evidence.restart.segmentsRenderedAfterRestart).toBe(
      evidence.restart.totalSegments,
    )
    expect(evidence.restart.directorRequestsAfterRestart).toBe(0)
    expect(evidence.restart.scriptUnchangedAcrossRestart).toBe(true)

    expect(evidence.counts.chapters).toBe(extracted.chapters.length)
    expect(evidence.counts.chapters).toBe(evidence.output.chapters.length)
    expect(evidence.counts.segments).toBe(evidence.restart.totalSegments)
    expect(evidence.output.m4b.bytes).toBeGreaterThan(0)
    expect(evidence.output.m4b.sha256).toMatch(/^[a-f\d]{64}$/u)
    expect(evidence.output.container.chapterMarkers).toBe(evidence.counts.chapters)
    expect(evidence.output.container.coverEmbedded).toBe(true)
    expect(evidence.output.container.titlePresent).toBe(true)
    expect(evidence.output.container.creatorPresent).toBe(true)
    expect(evidence.output.chapters).toHaveLength(extracted.chapters.length)
    for (const chapter of evidence.output.chapters) {
      expect(chapter.bytes).toBeGreaterThan(0)
      expect(chapter.sha256).toMatch(/^[a-f\d]{64}$/u)
    }
  })
})
