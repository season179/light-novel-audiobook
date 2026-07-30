import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DirectedChapter } from '@light-novel-audiobook/application'
import { Book, Chapter, ExactSourceCoverage, SourcePassage } from '@light-novel-audiobook/domain'
import { DirectorError } from '@light-novel-audiobook/gemma-director'
import { OPENAI_CLOUD_DIRECTOR_PROFILE, OpenAiCloudDirectorModel } from '../src/index.js'

const SYNTHETIC_SOURCE = 'A bell rang once.'

const loadRepositoryEnv = (): void => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  try {
    process.loadEnvFile(path.join(repositoryRoot, '.env'))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new DirectorError('configuration', 'Could not load repository-root .env configuration')
  }
}

const syntheticBook = (): Book => {
  const chapter = new Chapter({
    id: 'smoke-chapter-001',
    bookId: 'smoke-book-001',
    position: 1,
    title: 'Synthetic Smoke',
    sourcePassages: [
      new SourcePassage({
        id: 'smoke-passage-001',
        chapterId: 'smoke-chapter-001',
        sourceText: SYNTHETIC_SOURCE,
      }),
    ],
  })
  return new Book({
    id: 'smoke-book-001',
    title: 'Synthetic Smoke Fixture',
    author: null,
    coverPath: null,
    source: { epubPath: '/synthetic/openai-cloud-smoke.epub', sha256: '0'.repeat(64) },
    chapters: [chapter],
  })
}

const assertAccepted = (book: Book, result: DirectedChapter): void => {
  if (result.chapterId !== book.chapters[0]?.id) {
    throw new DirectorError('schema_validation', 'Real smoke returned the wrong chapter identity')
  }
  ExactSourceCoverage.createSegments(book.chapters[0] as Chapter, result.segments)
}

const run = async (): Promise<void> => {
  loadRepositoryEnv()
  const apiKey = process.env.OPENAI_API_KEY
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new DirectorError(
      'configuration',
      'OPENAI_API_KEY is required for the OpenAI cloud director real smoke',
    )
  }

  const model = new OpenAiCloudDirectorModel({
    apiKey,
    confidenceThreshold: 0.5,
    contextProvider: {
      forChapter: async () => ({
        speakers: [],
        narratorSpeakerId: 'synthetic-narrator',
        fallbackSpeakerId: 'synthetic-fallback',
      }),
    },
  })
  try {
    if (
      model.modelIdentity.modelId !== OPENAI_CLOUD_DIRECTOR_PROFILE.modelId ||
      model.modelIdentity.profileId !== OPENAI_CLOUD_DIRECTOR_PROFILE.id
    ) {
      throw new DirectorError(
        'configuration',
        'Real smoke model identity is not the locked profile',
      )
    }
    const book = syntheticBook()
    const result = await model.directChapter(book, book.chapters[0] as Chapter)
    assertAccepted(book, result)
    process.stdout.write(
      `${JSON.stringify({
        schema: 'openai-cloud-director-real-smoke@1',
        ok: true,
        modelId: model.modelIdentity.modelId,
        profileId: model.modelIdentity.profileId,
        directorIdentity: model.identity,
        requestSha256: result.requestSha256,
        outputSha256: result.outputSha256,
        passageCount: 1,
        segmentCount: result.segments.length,
      })}\n`,
    )
  } finally {
    await model.release()
  }
}

void run().catch((error: unknown) => {
  const safe =
    error instanceof DirectorError
      ? error
      : new DirectorError('unexpected', 'OpenAI cloud director real smoke failed unexpectedly')
  process.stderr.write(
    `${JSON.stringify({
      schema: 'openai-cloud-director-real-smoke@1',
      ok: false,
      code: safe.code,
      message: safe.message,
      retryable: safe.retryable,
    })}\n`,
  )
  process.exitCode = 1
})
