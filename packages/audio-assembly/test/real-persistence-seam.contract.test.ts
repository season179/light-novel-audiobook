import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AssembleAudiobookRequest,
  CompletedSegmentAudio,
} from '@light-novel-audiobook/application'
import { layoutFor, openWorkspace, SqliteJobRepository } from '@light-novel-audiobook/persistence'
import { afterEach, describe, expect, it } from 'vitest'
import { type CommandRunner, FfmpegAudioAssembler } from '../src/index.js'
import { makeBook } from './fixtures.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('real persistence to audio-assembly contract', () => {
  it('accepts chapter paths reserved by the real SQLite repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lna-real-persistence-assembly-'))
    roots.push(root)
    const layout = layoutFor(root)
    const db = openWorkspace(layout)

    try {
      const repository = new SqliteJobRepository(layout, db)
      const { book } = makeBook({
        title: 'Real Seam',
        chapters: [{ title: 'First', pauses: [0] }],
      })
      const reservation = await repository.reserveNextOutput(book)
      const chapter = book.chapters[0]
      const segment = chapter?.segments[0]
      if (chapter === undefined || segment === undefined) throw new Error('Fixture segment missing')

      const wavPath = join(layout.wavDir, `${segment.id}.wav`)
      await writeFile(wavPath, 'planner-only WAV placeholder')
      const audio: CompletedSegmentAudio = {
        segmentId: segment.id,
        inputIdentity: 'a'.repeat(64),
        wavPath,
        sha256: 'b'.repeat(64),
        byteLength: 28,
      }
      const request: AssembleAudiobookRequest = {
        book,
        reservation,
        chapters: [{ chapter, segments: [{ segment, audio }] }],
      }

      // Reaching the runner proves the real assembler accepted and planned the real repository's
      // reservation. The sentinel prevents any FFmpeg process from being started.
      const planningAccepted = new Error('assembly planning accepted')
      let runnerCalls = 0
      const runner: CommandRunner = {
        run: async () => {
          runnerCalls += 1
          throw planningAccepted
        },
      }
      const assembler = new FfmpegAudioAssembler({
        toolchain: {
          ffmpegPath: '/not-started/ffmpeg',
          ffprobePath: '/not-started/ffprobe',
          ffmpegVersion: '7.0.2-contract',
          ffprobeVersion: '7.0.2-contract',
        },
        runner,
      })

      await expect(assembler.assemble(request)).rejects.toBe(planningAccepted)
      expect(runnerCalls).toBe(1)
      expect(reservation.chapters.map((entry) => entry.path)).toEqual([
        expect.stringMatching(/\.flac$/u),
      ])
    } finally {
      db.close()
    }
  })
})
