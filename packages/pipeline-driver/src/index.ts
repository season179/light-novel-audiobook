// Re-exported, not redefined. This package owned a second, independently written copy of
// `OwnedLlamaLifecycle` until issue/lifecycle-dedup; the class now lives in gemma-director, which owns
// `DirectorRuntimeLifecycle` and the pinned Gemma profile it is built from. Re-exporting keeps this
// package's public surface unchanged for existing importers.
export {
  llamaRuntimePaths,
  llamaServerArgs,
  OwnedLlamaLifecycle,
  type OwnedLlamaLifecycleOptions,
} from '@light-novel-audiobook/gemma-director'
export {
  type RunPipelineOptions,
  type RunPipelineReport,
  runConfirmedRender,
  runPipeline,
} from './driver.js'
export { NarrationEchoDirectorServer } from './fake-director-server.js'
export {
  type ApproveFallbackReviewReport,
  type FallbackReviewApprovalNotice,
  type FallbackReviewCommandOptions,
  type FallbackReviewItem,
  type FallbackReviewReport,
  type ListFallbackReviewReport,
  runFallbackReviewCommand,
} from './fallback-review-cli.js'
export {
  canonicalSliceDescriptor,
  type SliceLimits,
  type SliceReport,
  SlicingEpubExtractor,
} from './slice.js'
export {
  createFakeTransports,
  createRealTransports,
  type DirectorRuntimeTransport,
  type PipelineTransports,
  type RealTransportConfig,
  resolveDefaultModelSnapshotPath,
  type TransportPaths,
} from './transports.js'
export { type DerivedCast, deriveVoiceCast } from './voice-cast.js'
