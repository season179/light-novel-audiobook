export {
  type ExclusiveGpuLeaseCoordinator,
  FileGpuLeaseCoordinator,
  type FileGpuLeaseCoordinatorConfig,
  type GpuLease,
  GpuLeaseError,
  type GpuOwner,
} from '@light-novel-audiobook/gpu-lease'
export {
  type FallbackApprovalRecord,
  QwenApplicationSpeechEngine,
  type QwenApplicationSpeechEngineOptions,
} from './application-adapter.js'
export {
  assertApprovedSpeakersPresent,
  assertDistinctProfileMaterial,
  type ProfileMaterial,
} from './cast-distinctness.js'
export {
  type LoadedProductionConfig,
  loadProductionConfig,
  type MpsMvpVoiceDecision,
  type MpsMvpVoicePolicy,
  type QwenProductionConfig,
  type SelectedVoiceProfile,
  type VoiceProfile,
} from './config.js'
export {
  type QwenManagedBatch,
  type QwenTtsEngineConfig,
  QwenTtsSpeechEngine,
} from './engine.js'
export {
  canonicalJson,
  DEFAULT_DELIVERY,
  deriveSeed,
  effectiveInstruction,
  sha256,
} from './manifest.js'
export { prepareEmptySmokeOutputRoot } from './smoke-output.js'
export { createQwenSpeechEngineFactory } from './speech-engine-factory.js'
export {
  APPROVED_SPEAKERS,
  type ApprovedSpeaker,
  AUDITIONED_SPEAKERS,
  type AuditionedSpeaker,
  type ExclusiveGpuGate,
  type FallbackApproval,
  SELECTED_VOICE_PROFILE_IDS,
  type SelectedVoiceProfileId,
  type SpeechBatchResult,
  type SpeechDeliveryDirection,
  type SpeechEngine,
  SpeechEngineError,
  type SpeechEngineErrorCode,
  type SpeechProgressEvent,
  type SpeechRenderOptions,
  type SpeechSegmentRequest,
  type SpeechSegmentResult,
  VOICE_PROFILE_IDS,
  type VoiceProfileId,
} from './types.js'
export {
  type CanonicalWavHeader,
  readCanonicalWavHeader,
  validateCanonicalWav,
  validateCanonicalWavBytes,
  validateCanonicalWavHeader,
} from './wav.js'
