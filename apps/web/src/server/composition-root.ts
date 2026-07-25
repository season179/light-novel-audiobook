import {
  type AudioAssembler,
  type DirectorModel,
  type EpubExtractor,
  GenerateAudiobook,
  type JobRepository,
  type SpeechEngine,
} from '@light-novel-audiobook/application'
import type { VoiceCast } from '@light-novel-audiobook/domain'
import { AudiobookWebApi } from './audiobook-web-api.js'
import { BookReadModelStore, ProjectingJobRepository } from './book-read-model.js'
import { EpubUploadStore } from './epub-upload-store.js'
import { FakeAudioAssembler } from './fakes/fake-audio-assembler.js'
import { FakeDirectorModel } from './fakes/fake-director-model.js'
import { FakeEpubExtractor } from './fakes/fake-epub-extractor.js'
import { FakeSpeechEngine } from './fakes/fake-speech-engine.js'
import { InMemoryJobRepository } from './fakes/in-memory-job-repository.js'
import { GenerationRunner } from './generation-runner.js'
import { createM1VoiceCast } from './m1-voice-cast.js'
import { createWorkspace, type LocalWorkspace } from './workspace.js'

/**
 * The single place where concrete adapters meet the application ports.
 *
 * Everything above this file depends on the ports only. Today the boundary adapters are the fakes
 * in `./fakes`, which need no GPU and no models; issue #21 swaps them for the real EPUB extractor
 * (#28), Gemma director (#30), Qwen speech engine (#31), FFmpeg assembler (#32), and SQLite job
 * repository (#27) by replacing the overrides below. No page, component, or server function changes.
 */
export interface AudiobookAdapterOverrides {
  readonly epubExtractor?: EpubExtractor | undefined
  readonly directorModel?: DirectorModel | undefined
  readonly speechEngine?: SpeechEngine | undefined
  readonly audioAssembler?: AudioAssembler | undefined
  readonly jobs?: JobRepository | undefined
  readonly voices?: VoiceCast | undefined
}

export interface AudiobookWebApiOptions extends AudiobookAdapterOverrides {
  readonly workspaceRoot?: string | undefined
  readonly workspace?: LocalWorkspace | undefined
}

export const createAudiobookWebApi = async (
  options: AudiobookWebApiOptions = {},
): Promise<AudiobookWebApi> => {
  const workspace = options.workspace ?? (await createWorkspace(options.workspaceRoot))
  const books = new BookReadModelStore()
  const jobs = new ProjectingJobRepository(
    options.jobs ?? new InMemoryJobRepository(workspace),
    books,
  )
  const generate = new GenerateAudiobook({
    epubExtractor: options.epubExtractor ?? new FakeEpubExtractor(),
    directorModel: options.directorModel ?? new FakeDirectorModel(),
    speechEngine: options.speechEngine ?? new FakeSpeechEngine(workspace),
    audioAssembler: options.audioAssembler ?? new FakeAudioAssembler(),
    jobs,
  })

  return new AudiobookWebApi({
    workspace,
    uploads: new EpubUploadStore(workspace),
    jobs,
    books,
    runner: new GenerationRunner(generate),
    voices: options.voices ?? createM1VoiceCast(),
  })
}

let instance: Promise<AudiobookWebApi> | undefined

/** Lazily built once per server process; never at import time, so builds stay side-effect free. */
export const getAudiobookWebApi = (): Promise<AudiobookWebApi> => {
  instance ??= createAudiobookWebApi()
  return instance
}
