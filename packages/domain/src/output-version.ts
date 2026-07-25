import { DomainError } from './errors.js'

export class OutputVersion {
  readonly value: number

  constructor(value: number) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new DomainError('Output version must be a positive integer')
    }
    this.value = value
    Object.freeze(this)
  }

  get label(): string {
    return `v${String(this.value).padStart(3, '0')}`
  }

  fileName(baseName: string, extension: string): string {
    if (baseName.length === 0 || extension.length === 0 || extension.includes('.')) {
      throw new DomainError('Output base name and extension are required')
    }
    return `${baseName}-${this.label}.${extension}`
  }
}

export interface ChapterAudioOutput {
  readonly chapterId: string
  readonly path: string
}

export interface AudiobookOutput {
  readonly version: OutputVersion
  readonly m4bPath: string
  readonly chapters: readonly ChapterAudioOutput[]
}
