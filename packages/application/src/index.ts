export { validateCompletedSegmentAudioMetadata } from './completed-segment-audio.js'
export {
  DirectAudiobook,
  type DirectAudiobookCommand,
  type DirectAudiobookDependencies,
  type DirectAudiobookResult,
} from './direct-audiobook.js'
export {
  approvalStillDescribes,
  collectFallbackSubjects,
  createFallbackApprovalRecord,
  FALLBACK_EXCERPT_MAX_LENGTH,
  type FallbackApprovalDecision,
  type FallbackApprovalSubject,
  fallbackApprovalExcerpt,
  hashSourceText,
  type PendingFallbackApproval,
  type PersistedFallbackApproval,
} from './fallback-approval.js'
export {
  GenerateAudiobook,
  type GenerateAudiobookCommand,
  type GenerateAudiobookDependencies,
  type GenerateAudiobookResult,
  PendingFallbackReviewError,
} from './generate-audiobook.js'
export {
  createGenerationCommandIdentity,
  type GenerationCommandIdentityInput,
} from './generation-command-identity.js'
export type {
  AssembleAudiobookRequest,
  AssemblyChapter,
  AssemblySegment,
  AudioAssembler,
  CompletedSegmentAudio,
  DirectedChapter,
  DirectorModel,
  EpubExtractionRequest,
  EpubExtractor,
  FallbackApprovalRepository,
  JobRepository,
  OutputReservation,
  ReusableSegmentQuery,
  SpeechEngine,
  SpeechEngineContext,
  SpeechEngineFactory,
  SpeechRenderRequest,
} from './ports.js'
export {
  RenderAudiobook,
  type RenderAudiobookCommand,
  type RenderAudiobookDependencies,
  type RenderAudiobookResult,
  UnapprovedFallbackSegmentsError,
} from './render-audiobook.js'
export { createRenderInputIdentity, type RenderInputApproval } from './render-input-identity.js'
export {
  FALLBACK_APPROVAL_POLICIES,
  type FallbackApprovalDecisionRequest,
  type FallbackApprovalPolicy,
  type FallbackApprovalReconciliation,
  type ReconcileFallbackApprovalsRequest,
  ReviewFallbackApprovals,
  type ReviewFallbackApprovalsDependencies,
} from './review-fallback-approvals.js'
