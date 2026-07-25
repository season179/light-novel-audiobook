export {
  type LlamaCppCapabilities,
  LlamaCppSpikeClient,
  type LlamaCppSpikeClientOptions,
  type StructuredRequestOptions,
} from './client'
export {
  DEFAULT_BRAIN_ENDPOINT,
  DEFAULT_BRAIN_HOST,
  DEFAULT_BRAIN_PORT,
  LoopbackEndpoint,
} from './config'
export { classifyError, SpikeError, type SpikeErrorCode } from './errors'
export {
  type ImplementationIdentity,
  readImplementationIdentity,
} from './implementation-identity'
export {
  LoopbackRecordingFetch,
  type LoopbackRecordingFetchOptions,
  loopbackHttpFetch,
  type SanitizedRequestCapture,
} from './recording-fetch'
export {
  type SyntheticStructuredOutput,
  SyntheticStructuredOutputSchema,
} from './schema'
export { SlotPool, type SlotPoolSnapshot } from './slot-pool'
