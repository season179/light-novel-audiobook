export {
  assertAbsoluteCanonicalPath,
  metadataArguments,
  normalizeMetadataValue,
  safeFileArgument,
  safeMetadataKey,
} from './argument-safety.js'
export {
  type AssemblyPlan,
  type PlannedChapter,
  type PlannedSegment,
  planAssembly,
  resolveSegmentPauseMs,
} from './assembly-plan.js'
export { buildBookTags, buildChapterTags, type MetadataTag } from './book-metadata.js'
export {
  type CommandResult,
  type CommandRunner,
  runChecked,
  SpawnCommandRunner,
} from './command-runner.js'
export {
  type AudiobookCommand,
  buildAudiobookArgs,
  buildChapterMasterArgs,
  buildCoverProbeArgs,
  buildLoudnessAnalysisArgs,
  buildProbeArgs,
  buildSegmentConcatArgs,
  type ChapterMasterCommand,
  type CoverArtHandling,
  type LoudnessAnalysisCommand,
  type PaddedInput,
  type SegmentConcatCommand,
} from './commands.js'
export {
  AssemblyOrderError,
  AudioAssemblyError,
  FfmpegProcessError,
  FfmpegToolchainError,
  OutputExistsError,
} from './errors.js'
export {
  buildFfmetadata,
  escapeFfmetadata,
  type FfmetadataChapter,
  type FfmetadataDocument,
} from './ffmetadata.js'
export {
  type AssembledChapterOutput,
  type AudiobookAssemblyResult,
  FfmpegAudioAssembler,
  type FfmpegAudioAssemblerOptions,
} from './ffmpeg-audio-assembler.js'
export {
  defaultFfmpegDirectory,
  EXPECTED_FFMPEG_VERSION,
  FFMPEG_DIRECTORY_ENV,
  type FfmpegToolchain,
  parseToolVersion,
  type ResolveToolchainOptions,
  resolveFfmpegToolchain,
} from './ffmpeg-toolchain.js'
export {
  type ProbedAudioStream,
  type ProbedChapter,
  type ProbeResult,
  parseProbeJson,
  probedDurationMs,
} from './ffprobe.js'
export {
  computeLoudnessGainDb,
  type LoudnessGainDecision,
  type LoudnessGainInput,
  type LoudnessGainLimit,
  type LoudnessMeasurement,
  parseLoudnormMeasurement,
} from './loudness.js'
export {
  ASSEMBLY_MANIFEST_SCHEMA,
  type AssemblyManifest,
  canonicalJson,
  chapterBitDepth,
  createAssemblerIdentity,
  type ManifestChapterEntry,
  serializeManifest,
} from './manifest.js'
export {
  assertOutputAbsent,
  assertOutputPresent,
  claimOutputPath,
  pathExists,
  rollbackClaimedOutputs,
} from './no-overwrite.js'
export { sanitizeFileNameComponent } from './output-naming.js'
export {
  type AssemblySettings,
  DEFAULT_ASSEMBLY_SETTINGS,
  resolveAssemblySettings,
} from './settings.js'
