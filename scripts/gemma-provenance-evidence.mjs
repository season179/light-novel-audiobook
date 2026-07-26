const SELECTED_MODEL_ID = 'google-gemma-4-26b-a4b-it-qat-q4-0'
const PINNED_GGUF_BYTES = 14_439_363_584
const SHA256 = /^[a-f\d]{64}$/u
const POSITIVE_INTEGER = /^[1-9]\d*$/u

export class GemmaProvenanceEvidenceError extends Error {}

const fail = (message) => {
  throw new GemmaProvenanceEvidenceError(message)
}

const exactKeys = (value, expected, label) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.join(',') !== wanted.join(',')) {
    fail(`${label} fields are ${actual.join(',')}, expected ${wanted.join(',')}`)
  }
}

const positivePid = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive PID`)
}

const monotonicNs = (value, label) => {
  if (typeof value !== 'string' || !POSITIVE_INTEGER.test(value)) {
    fail(`${label} must be monotonic nanoseconds`)
  }
  return BigInt(value)
}

const requireTrue = (value, label) => {
  if (value !== true) fail(`${label} must be true`)
}

const validateReceipt = (receipt, index, llama) => {
  const label = `director request ${index + 1}`
  exactKeys(
    receipt,
    [
      'completedAtMonotonicNs',
      'llamaServerPid',
      'ordinal',
      'passageCount',
      'passageIds',
      'requestId',
      'requestSha256',
      'responseCompleted',
      'responseStatus',
      'schema',
      'startedAtMonotonicNs',
    ],
    label,
  )
  if (receipt.schema !== 'gemma-director-request-receipt@1') fail(`${label} schema is invalid`)
  if (receipt.ordinal !== index + 1) fail(`${label} ordinal is not contiguous`)
  if (typeof receipt.requestId !== 'string' || receipt.requestId.length === 0) {
    fail(`${label} has no request id`)
  }
  if (!SHA256.test(receipt.requestSha256)) fail(`${label} request hash is invalid`)
  if (!Array.isArray(receipt.passageIds) || receipt.passageIds.length === 0) {
    fail(`${label} has no passage ids`)
  }
  if (
    !Number.isSafeInteger(receipt.passageCount) ||
    receipt.passageCount !== receipt.passageIds.length
  ) {
    fail(`${label} passage count disagrees with its ids`)
  }
  if (
    receipt.passageIds.some(
      (id) => typeof id !== 'string' || !/^book-[a-f\d]+-ch\d{4}-p\d{6}$/u.test(id),
    )
  ) {
    fail(`${label} carries a non-stable passage id`)
  }
  if (receipt.responseStatus !== 200 || receipt.responseCompleted !== true) {
    fail(`${label} was not served to completion`)
  }
  if (receipt.llamaServerPid !== llama.pid) fail(`${label} is bound to another process`)
  const started = monotonicNs(receipt.startedAtMonotonicNs, `${label} start`)
  const completed = monotonicNs(receipt.completedAtMonotonicNs, `${label} completion`)
  if (
    started < monotonicNs(llama.firstObservedAtMonotonicNs, 'llama first observation') ||
    completed < started ||
    completed > monotonicNs(llama.deathObservedAtMonotonicNs, 'llama death observation')
  ) {
    fail(`${label} falls outside the observed llama-server lifetime`)
  }
}

const validateInterval = (interval, expectedOwner) => {
  exactKeys(
    interval,
    [
      'endedAtMonotonicNs',
      'holderAliveAfterRelease',
      'holderPid',
      'mode',
      'owner',
      'releaseObserved',
      'samples',
      'startedAtMonotonicNs',
    ],
    `${expectedOwner} flock interval`,
  )
  if (interval.owner !== expectedOwner) fail(`expected ${expectedOwner} flock interval`)
  positivePid(interval.holderPid, `${expectedOwner} flock holder`)
  if (interval.mode !== 'WRITE') fail(`${expectedOwner} flock was not exclusive`)
  if (!Number.isSafeInteger(interval.samples) || interval.samples < 1) {
    fail(`${expectedOwner} flock interval has no samples`)
  }
  requireTrue(interval.releaseObserved, `${expectedOwner} flock release`)
  if (interval.holderAliveAfterRelease !== false) {
    fail(`${expectedOwner} flock holder remained alive after release`)
  }
  const started = monotonicNs(interval.startedAtMonotonicNs, `${expectedOwner} flock start`)
  const ended = monotonicNs(interval.endedAtMonotonicNs, `${expectedOwner} flock end`)
  if (ended < started) fail(`${expectedOwner} flock interval runs backward`)
  return { started, ended }
}

/** Strict, text-free acceptance validator for the committed one-run provenance document. */
export const assertGemmaProvenanceEvidence = (evidence) => {
  exactKeys(
    evidence,
    [
      'assertions',
      'cleanup',
      'directorRequests',
      'fixture',
      'generatedAt',
      'kernelFlockIntervals',
      'llamaServer',
      'qwen',
      'run',
      'sampling',
      'schema',
    ],
    'evidence',
  )
  if (evidence.schema !== 'issue-21-gemma-provenance@1') fail('evidence schema is invalid')
  if (!Number.isFinite(Date.parse(evidence.generatedAt))) fail('evidence timestamp is invalid')

  exactKeys(evidence.fixture, ['byteLength', 'sha256', 'slice'], 'fixture')
  if (!SHA256.test(evidence.fixture.sha256) || evidence.fixture.byteLength < 1) {
    fail('fixture identity is invalid')
  }
  exactKeys(
    evidence.fixture.slice,
    ['firstChapter', 'maxChapters', 'maxPassagesPerChapter'],
    'fixture slice',
  )
  if (
    evidence.fixture.slice.firstChapter !== 1 ||
    evidence.fixture.slice.maxChapters !== 1 ||
    evidence.fixture.slice.maxPassagesPerChapter !== 1
  ) {
    fail('provenance run is not the one-passage bounded slice')
  }
  exactKeys(evidence.sampling, ['intervalMs', 'samples'], 'sampling')
  if (evidence.sampling.intervalMs !== 75 || evidence.sampling.samples < 1) {
    fail('sampling evidence is empty or uses the wrong interval')
  }

  const llama = evidence.llamaServer
  exactKeys(
    llama,
    [
      'commandAlias',
      'commandModelPath',
      'deathObservedAtMonotonicNs',
      'executablePath',
      'firstObservedAtMonotonicNs',
      'lastObservedAtMonotonicNs',
      'listenerOwnedAtModelProbe',
      'modelEndpointStatus',
      'pid',
      'pinnedGgufByteLength',
      'pinnedGgufPath',
      'processStartTimeTicks',
      'reportedModelIds',
    ],
    'llama-server',
  )
  positivePid(llama.pid, 'llama-server')
  if (
    typeof llama.executablePath !== 'string' ||
    !llama.executablePath.endsWith('/llama-server') ||
    llama.commandModelPath !== llama.pinnedGgufPath ||
    !llama.pinnedGgufPath.endsWith('/gemma-4-26B_q4_0-it.gguf') ||
    llama.pinnedGgufByteLength !== PINNED_GGUF_BYTES ||
    llama.commandAlias !== SELECTED_MODEL_ID ||
    llama.modelEndpointStatus !== 200 ||
    !Array.isArray(llama.reportedModelIds) ||
    !llama.reportedModelIds.includes(SELECTED_MODEL_ID)
  ) {
    fail('llama-server executable, GGUF, alias, or reported model is not pinned')
  }
  requireTrue(llama.listenerOwnedAtModelProbe, 'llama-server listener ownership')
  if (
    typeof llama.processStartTimeTicks !== 'string' ||
    !POSITIVE_INTEGER.test(llama.processStartTimeTicks)
  ) {
    fail('llama-server process start time is invalid')
  }
  const llamaFirst = monotonicNs(llama.firstObservedAtMonotonicNs, 'llama first observation')
  const llamaLast = monotonicNs(llama.lastObservedAtMonotonicNs, 'llama last observation')
  const llamaDeath = monotonicNs(llama.deathObservedAtMonotonicNs, 'llama death observation')
  if (llamaLast < llamaFirst || llamaDeath < llamaLast) fail('llama-server lifetime runs backward')

  if (!Array.isArray(evidence.directorRequests) || evidence.directorRequests.length === 0) {
    fail('director request evidence is empty')
  }
  evidence.directorRequests.forEach((receipt, index) => {
    validateReceipt(receipt, index, llama)
  })

  if (!Array.isArray(evidence.kernelFlockIntervals) || evidence.kernelFlockIntervals.length !== 2) {
    fail('expected exactly one Gemma and one Qwen flock interval')
  }
  const gemma = validateInterval(evidence.kernelFlockIntervals[0], 'gemma')
  const qwen = validateInterval(evidence.kernelFlockIntervals[1], 'qwen3-tts')
  if (gemma.ended > qwen.started) fail('Gemma and Qwen flock intervals overlap')
  if (llamaDeath > qwen.started) fail('llama-server remained alive when Qwen acquired the flock')

  exactKeys(evidence.qwen, ['workerPids'], 'Qwen process evidence')
  if (!Array.isArray(evidence.qwen.workerPids) || evidence.qwen.workerPids.length === 0) {
    fail('no Qwen worker PID was observed')
  }
  evidence.qwen.workerPids.forEach((pid) => {
    positivePid(pid, 'Qwen worker')
  })

  exactKeys(
    evidence.run,
    ['generatedSegments', 'm4bBytes', 'm4bSha256', 'reusedSegments', 'stage', 'state'],
    'run result',
  )
  if (
    evidence.run.state !== 'completed' ||
    evidence.run.stage !== 'completed' ||
    evidence.run.generatedSegments !== 1 ||
    evidence.run.reusedSegments !== 0 ||
    evidence.run.m4bBytes < 1 ||
    !SHA256.test(evidence.run.m4bSha256)
  ) {
    fail('bounded real run did not complete one generated segment and output')
  }

  exactKeys(
    evidence.cleanup,
    [
      'directorPortFree',
      'expectedIdleMemoryMiB',
      'gpuAfter',
      'gpuBefore',
      'kernelFlockHoldersRemaining',
      'modelProcessesRemaining',
      'quarantineMarkerPresent',
      'webPortFree',
    ],
    'cleanup',
  )
  for (const [label, gpu] of [
    ['before', evidence.cleanup.gpuBefore],
    ['after', evidence.cleanup.gpuAfter],
  ]) {
    exactKeys(gpu, ['memoryTotalMiB', 'memoryUsedMiB', 'utilizationPercent'], `GPU ${label}`)
  }
  if (
    evidence.cleanup.expectedIdleMemoryMiB !== 379 ||
    evidence.cleanup.gpuBefore.memoryUsedMiB !== 379 ||
    evidence.cleanup.gpuAfter.memoryUsedMiB !== 379 ||
    evidence.cleanup.gpuBefore.utilizationPercent !== 0 ||
    evidence.cleanup.gpuAfter.utilizationPercent !== 0 ||
    evidence.cleanup.modelProcessesRemaining !== 0 ||
    evidence.cleanup.kernelFlockHoldersRemaining !== 0 ||
    evidence.cleanup.webPortFree !== true ||
    evidence.cleanup.directorPortFree !== true ||
    evidence.cleanup.quarantineMarkerPresent !== false
  ) {
    fail('post-run cleanup did not return to the measured idle baseline')
  }

  exactKeys(
    evidence.assertions,
    [
      'directorRequestCount',
      'everyDirectorRequestServedByObservedLlamaServer',
      'gemmaAndQwenIntervalsDisjoint',
      'gemmaFlockHolderPid',
      'listenerOwnedByObservedLlamaServer',
      'llamaDeadBeforeQwen',
      'noLlamaQwenCoResidency',
      'postRunClean',
      'qwenFlockHolderPid',
      'realLlamaServerObserved',
      'selectedModelReportedByServer',
    ],
    'assertions',
  )
  if (
    evidence.assertions.directorRequestCount !== evidence.directorRequests.length ||
    evidence.assertions.gemmaFlockHolderPid !== evidence.kernelFlockIntervals[0].holderPid ||
    evidence.assertions.qwenFlockHolderPid !== evidence.kernelFlockIntervals[1].holderPid
  ) {
    fail('assertion counts or holder PIDs are self-inconsistent')
  }
  for (const key of [
    'realLlamaServerObserved',
    'listenerOwnedByObservedLlamaServer',
    'selectedModelReportedByServer',
    'everyDirectorRequestServedByObservedLlamaServer',
    'gemmaAndQwenIntervalsDisjoint',
    'llamaDeadBeforeQwen',
    'noLlamaQwenCoResidency',
    'postRunClean',
  ]) {
    requireTrue(evidence.assertions[key], `assertion ${key}`)
  }
  return evidence
}
