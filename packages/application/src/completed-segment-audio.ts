import { isAbsolute } from 'node:path'
import { DomainError } from '@light-novel-audiobook/domain'
import type { CompletedSegmentAudio } from './ports.js'

/** Validates persisted metadata; repository adapters remain responsible for hashing physical bytes. */
export const validateCompletedSegmentAudioMetadata = (audio: CompletedSegmentAudio): void => {
  if (audio.segmentId.length === 0 || !/^[a-f\d]{64}$/i.test(audio.inputIdentity)) {
    throw new DomainError('Completed segment audio has invalid segment or input identity')
  }
  if (!isAbsolute(audio.wavPath) || audio.wavPath.includes('\0')) {
    throw new DomainError('Completed segment audio path must be a safe absolute path')
  }
  if (!/^[a-f\d]{64}$/i.test(audio.sha256)) {
    throw new DomainError('Completed segment audio SHA-256 is invalid')
  }
  if (!Number.isSafeInteger(audio.byteLength) || audio.byteLength < 1) {
    throw new DomainError('Completed segment audio byte length must be a positive integer')
  }
}
