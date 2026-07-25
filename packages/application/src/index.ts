export {
  type CompletedOutputDenial,
  type CompletedOutputStatus,
  inspectCompletedOutput,
} from './completed-output.js'
export { validateCompletedSegmentAudioMetadata } from './completed-segment-audio.js'
export { withDirectorContentIdentity } from './director-content-identity.js'
export {
  DirectAudiobook,
  type DirectAudiobookCommand,
  type DirectAudiobookDependencies,
  type DirectAudiobookResult,
} from './direct-audiobook.js'
export {
  approvalStillDescribes,
  type BookFallbackGrant,
  collectFallbackSubjects,
  createBookFallbackGrant,
  createFallbackApprovalRecord,
  FALLBACK_EXCERPT_MAX_LENGTH,
  type FallbackApprovalCatalog,
  type FallbackApprovalDecision,
  type FallbackApprovalExclusion,
  type FallbackApprovalSubject,
  type FallbackRevocation,
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
  DirectorModelFactory,
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
  RenderContractMismatchError,
  StaleFallbackCatalogError,
  UnapprovedFallbackSegmentsError,
} from './render-audiobook.js'
export { createRenderContract, type RenderContractInput } from './render-contract.js'
export { createRenderInputIdentity, type RenderInputApproval } from './render-input-identity.js'
export {
  type BookFallbackGrantRequest,
  type FallbackApprovalDecisionRequest,
  type FallbackApprovalReconciliation,
  type ReconcileFallbackApprovalsRequest,
  RenderInProgressError,
  ReviewFallbackApprovals,
  type ReviewFallbackApprovalsDependencies,
} from './review-fallback-approvals.js'
