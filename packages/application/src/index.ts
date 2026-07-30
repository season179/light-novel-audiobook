export {
  type CastApprovalDecision,
  type CastAssignment,
  type CastProposal,
  characterSharesFallbackMaterial,
  createCastApprovalRecord,
  type PersistedCastApproval,
  parseCastProposal,
  type SharedVoiceMaterialGroup,
  sharedVoiceMaterialGroups,
} from './cast-approval.js'
export {
  ApprovalCatalogAccess,
  ApprovalCatalogReentryError,
  approvalCatalogAccessFor,
  CompletedOutputAuthority,
  type CompletedOutputAuthorization,
  type CompletedOutputDenial,
} from './completed-output.js'
export { validateCompletedSegmentAudioMetadata } from './completed-segment-audio.js'
export {
  DirectAudiobook,
  type DirectAudiobookCommand,
  type DirectAudiobookDependencies,
  type DirectAudiobookResult,
} from './direct-audiobook.js'
export {
  createDirectionApprovalRecord,
  createDirectionScriptSha256,
  type DirectionApprovalDecision,
  type DirectionApprovalQuery,
  type PersistedDirectionApproval,
} from './direction-approval.js'
export { withDirectorContentIdentity } from './director-content-identity.js'
export {
  approvalStillDescribes,
  type BookFallbackGrant,
  type BookFallbackGrantSubject,
  collectFallbackSubjects,
  createBookFallbackGrant,
  createFallbackApprovalExclusion,
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
  CastApprovalRepository,
  CompletedSegmentAudio,
  DirectChapterOptions,
  DirectChapterProgress,
  DirectChapterProgressState,
  DirectedChapter,
  DirectionApprovalRepository,
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
  UnconfirmedDirectionError,
} from './render-audiobook.js'
export { createRenderContract, type RenderContractInput } from './render-contract.js'
export { createRenderInputIdentity, type RenderInputApproval } from './render-input-identity.js'
export {
  type ApproveCastRequest,
  ReviewCastApprovals,
  type ReviewCastApprovalsDependencies,
} from './review-cast-approvals.js'
export {
  type ConfirmDirectionRequest,
  ReviewDirection,
  type ReviewDirectionDependencies,
} from './review-direction.js'
export {
  type BookFallbackGrantRequest,
  type FallbackApprovalDecisionRequest,
  type FallbackApprovalReconciliation,
  type ReconcileFallbackApprovalsRequest,
  RenderInProgressError,
  ReviewFallbackApprovals,
  type ReviewFallbackApprovalsDependencies,
} from './review-fallback-approvals.js'
export {
  REVIEWER_ENV_VARIABLE,
  type ReviewerIdentity,
  resolveReviewerIdentity,
} from './reviewer-identity.js'
export {
  MAX_FRAGMENT_CHARACTERS,
  SEPARATOR_OVERSHOOT,
  splitDirectedSegments,
} from './split-directed-segments.js'
