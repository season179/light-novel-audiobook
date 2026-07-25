import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  AssembleAudiobookRequest,
  AssemblyChapter,
  AudioAssembler,
} from '@light-novel-audiobook/application'
import {
  type AudiobookOutput,
  type ChapterAudioOutput,
  DomainError,
} from '@light-novel-audiobook/domain'
import { concatenateWavs } from './placeholder-wav.js'

const SHA256 = /^[0-9a-f]{64}$/i

/**
 * FAKE assembler. It concatenates the placeholder segment WAVs into one file per chapter and one
 * whole-book file at the reserved numbered paths, so playback and download are real without FFmpeg.
 *
 * It enforces the same caller contract as the merged FFmpeg assembler's planner: chapter and segment
 * ordering, segment/audio identity, no duplicate segment, pairwise-distinct outputs, and never
 * overwriting a reserved path — the last one uses an exclusive create so the check and the write are
 * one operation rather than a stat and a hopeful write.
 *
 * It also **refuses a reservation whose chapter paths it cannot honour**. This fake produces WAV, so
 * a `.flac` (or extensionless) reservation is an error rather than WAV bytes written under the wrong
 * name. That is deliberate: silently accepting any extension is exactly what hid the real
 * persistence/FFmpeg reservation mismatch now tracked as #43. The RIFF-in-`.m4b` payload stays a
 * documented shortcut; issue #32's assembler replaces this.
 */
export class FakeAudioAssembler implements AudioAssembler {
  readonly identity = 'fake-assembler/2'

  async assemble(request: AssembleAudiobookRequest): Promise<AudiobookOutput> {
    const { book, reservation } = request
    this.assertReservationShape(request)

    const chapterBuffers: Buffer[] = []
    const chapters: ChapterAudioOutput[] = []
    for (const [index, entry] of request.chapters.entries()) {
      const reserved = reservation.chapters[index]
      const bookChapter = book.chapters[index]
      if (reserved === undefined || bookChapter === undefined) {
        throw new DomainError(`Missing chapter at position ${index + 1}`)
      }
      this.assertChapterOrder(entry, bookChapter, reserved.chapterId, index)

      const clips = await Promise.all(
        entry.segments.map((segment) => readFile(segment.audio.wavPath)),
      )
      const chapterAudio = concatenateWavs(clips)
      chapterBuffers.push(chapterAudio)
      await this.writeWithoutOverwriting(reserved.path, chapterAudio)
      chapters.push({ chapterId: reserved.chapterId, path: reserved.path })
    }

    await this.writeWithoutOverwriting(reservation.m4bPath, concatenateWavs(chapterBuffers))

    return { version: reservation.version, m4bPath: reservation.m4bPath, chapters }
  }

  private assertReservationShape(request: AssembleAudiobookRequest): void {
    const { book, reservation } = request
    if (
      reservation.chapters.length !== request.chapters.length ||
      request.chapters.length !== book.chapters.length
    ) {
      throw new DomainError('Assembly reservation does not match the directed chapters')
    }
    if (reservation.bookId !== book.id) {
      throw new DomainError('Assembly reservation belongs to another book')
    }
    if (!/\.m4b$/iu.test(reservation.m4bPath)) {
      throw new DomainError(`Reserved audiobook path must end in .m4b: ${reservation.m4bPath}`)
    }
    for (const chapter of reservation.chapters) {
      if (!/\.wav$/iu.test(chapter.path)) {
        throw new DomainError(
          `The fake assembler produces WAV and cannot honour reserved chapter master ${chapter.path}`,
        )
      }
    }
    const paths = [reservation.m4bPath, ...reservation.chapters.map((chapter) => chapter.path)]
    if (new Set(paths).size !== paths.length) {
      throw new DomainError('Reserved output paths must be pairwise distinct')
    }

    const seenSegmentIds = new Set<string>()
    for (const entry of request.chapters) {
      for (const item of entry.segments) {
        if (seenSegmentIds.has(item.segment.id)) {
          throw new DomainError(`Segment ${item.segment.id} appears more than once in the assembly`)
        }
        seenSegmentIds.add(item.segment.id)
      }
    }
  }

  private assertChapterOrder(
    entry: AssemblyChapter,
    bookChapter: AssemblyChapter['chapter'],
    reservedChapterId: string,
    index: number,
  ): void {
    if (entry.chapter.id !== bookChapter.id || entry.chapter.position !== index + 1) {
      throw new DomainError(
        `Chapter at position ${index + 1} is ${entry.chapter.id} but the book expects ${bookChapter.id}`,
      )
    }
    if (reservedChapterId !== bookChapter.id) {
      throw new DomainError(
        `Reserved chapter ${index + 1} is ${reservedChapterId} but the book expects ${bookChapter.id}`,
      )
    }
    if (entry.segments.length === 0) {
      throw new DomainError(`Chapter ${bookChapter.id} has no rendered segments`)
    }
    if (entry.segments.length !== bookChapter.segments.length) {
      throw new DomainError(
        `Chapter ${bookChapter.id} was assembled from ${entry.segments.length} segments but the approved chapter has ${bookChapter.segments.length}`,
      )
    }
    for (const [position, item] of entry.segments.entries()) {
      const approved = bookChapter.segments[position]
      const { segment, audio } = item
      if (approved === undefined || segment.id !== approved.id) {
        throw new DomainError(
          `Segment ${segment.id} was assembled at position ${position + 1} of chapter ${bookChapter.id} but the approved chapter has ${String(approved?.id)} there`,
        )
      }
      if (segment.chapterId !== bookChapter.id) {
        throw new DomainError(
          `Segment ${segment.id} belongs to chapter ${segment.chapterId}, not ${bookChapter.id}`,
        )
      }
      if (segment.order !== position + 1) {
        throw new DomainError(
          `Segment ${segment.id} is at index ${position + 1} but declares order ${segment.order}`,
        )
      }
      if (audio.segmentId !== segment.id) {
        throw new DomainError(
          `Rendered audio ${audio.segmentId} was supplied for segment ${segment.id}`,
        )
      }
      if (!SHA256.test(audio.sha256)) {
        throw new DomainError(`Rendered audio for ${segment.id} has no usable SHA-256`)
      }
    }
  }

  /** `wx` fails with EEXIST rather than clobbering a previous export. */
  private async writeWithoutOverwriting(path: string, bytes: Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(path, bytes, { flag: 'wx' })
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : null
      if (code === 'EEXIST') {
        throw new DomainError(
          `Reserved output already exists and must never be overwritten: ${path}`,
        )
      }
      throw error
    }
  }
}
