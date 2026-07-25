import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AssembleAudiobookRequest, AudioAssembler } from '@light-novel-audiobook/application'
import {
  type AudiobookOutput,
  type ChapterAudioOutput,
  DomainError,
} from '@light-novel-audiobook/domain'
import { concatenateWavs } from './placeholder-wav.js'

/**
 * FAKE assembler. It concatenates the placeholder segment WAVs into one file per chapter and one
 * whole-book file at the reserved numbered paths, so playback and download are real without FFmpeg.
 * Issue #32 replaces it.
 */
export class FakeAudioAssembler implements AudioAssembler {
  readonly identity = 'fake-assembler/1'

  async assemble(request: AssembleAudiobookRequest): Promise<AudiobookOutput> {
    const { reservation } = request
    if (reservation.chapters.length !== request.chapters.length) {
      throw new DomainError('Assembly reservation does not match the directed chapters')
    }

    const chapterBuffers: Buffer[] = []
    const chapters: ChapterAudioOutput[] = []
    for (const [index, chapter] of request.chapters.entries()) {
      const reserved = reservation.chapters[index]
      if (reserved === undefined || reserved.chapterId !== chapter.chapter.id) {
        throw new DomainError('Assembly reservation is out of chapter order')
      }
      const clips = await Promise.all(
        chapter.segments.map((segment) => readFile(segment.audio.wavPath)),
      )
      const chapterAudio = concatenateWavs(clips)
      chapterBuffers.push(chapterAudio)
      await mkdir(dirname(reserved.path), { recursive: true })
      await writeFile(reserved.path, chapterAudio)
      chapters.push({ chapterId: reserved.chapterId, path: reserved.path })
    }

    await mkdir(dirname(reservation.m4bPath), { recursive: true })
    await writeFile(reservation.m4bPath, concatenateWavs(chapterBuffers))

    return {
      version: reservation.version,
      m4bPath: reservation.m4bPath,
      chapters,
    }
  }
}
