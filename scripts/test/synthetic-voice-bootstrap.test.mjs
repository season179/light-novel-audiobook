import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  analyzePcm16Wav,
  createManualReview,
  deriveObjectiveReview,
  loadBootstrapLock,
  stableJsonHash,
} from '../synthetic-voices/core.mjs'
import { sha256 } from '../voxcpm2/core.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const lockPath = join(root, 'config/synthetic-voice-bootstrap.lock.json')

function sineWav({ frequency = 150, seconds = 1, sampleRateHz = 16000, amplitude = 8000 } = {}) {
  const frames = Math.round(seconds * sampleRateHz)
  const buffer = Buffer.alloc(44 + frames * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRateHz, 24)
  buffer.writeUInt32LE(sampleRateHz * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(frames * 2, 40)
  for (let index = 0; index < frames; index += 1) {
    buffer.writeInt16LE(
      Math.round(amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRateHz)),
      44 + index * 2,
    )
  }
  return buffer
}

function mockAnalysis(pitch, durationSeconds = 3) {
  return {
    audio: { durationSeconds },
    objective: {
      clippedSampleFraction: 0,
      activeFrameFraction: 0.95,
      estimatedMedianPitchHz: pitch,
      rmsDbfs: -18,
    },
  }
}

async function passingFixture() {
  const lock = await loadBootstrapLock(lockPath)
  const pitches = [100, 140, 210]
  const references = lock.candidates.map((candidate, index) => ({
    candidateId: candidate.id,
    sha256: `${index + 1}`.repeat(64),
    repeatSha256: `${index + 1}`.repeat(64),
    analysis: mockAnalysis(pitches[index], 7),
  }))
  const outputs = []
  for (const [candidateIndex, candidate] of lock.candidates.entries()) {
    for (const line of lock.lines) {
      outputs.push({
        candidateId: candidate.id,
        lineId: line.id,
        repetition: 0,
        text: line.text,
        referenceSha256: references[candidateIndex].sha256,
        sha256: sha256(`${candidate.id}:${line.id}`),
        analysis: mockAnalysis(pitches[candidateIndex], 3),
        file: `outputs/${candidate.id}/${line.id}.wav`,
      })
    }
    const repeated = outputs.find(
      ({ candidateId, lineId }) =>
        candidateId === candidate.id && lineId === lock.generation.repeatLineId,
    )
    outputs.push({ ...repeated, repetition: 1, file: repeated.file.replace('.wav', '-repeat.wav') })
  }
  return { lock, references, outputs }
}

test('the lock pins GPL source, formant voices, authored transcripts, and issue #7 mode', async () => {
  const lock = await loadBootstrapLock(lockPath)
  assert.equal(lock.espeakNg.revision, '4870adfa25b1a32b4361592f1be8a40337c58d6c')
  assert.equal(lock.espeakNg.license, 'GPL-3.0-or-later')
  assert.equal(lock.espeakNg.build.mbrola, false)
  assert.deepEqual(
    lock.candidates.map(({ voice }) => voice),
    ['en-us', 'en-us+m3', 'en-us+f4'],
  )
  assert.ok(lock.candidates.every(({ seed }) => seed === null))
  assert.equal(lock.voxcpm2.mode, 'serialized-non-streaming-experimental-only')
  assert.equal(lock.voxcpm2.endpointPath, '/v1/audio/speech')
  assert.equal(stableJsonHash(lock.espeakNg.build).length, 64)
})

test('objective PCM analysis measures speech activity, clipping, and distinguishable pitch', () => {
  const low = analyzePcm16Wav(sineWav({ frequency: 100 }))
  const high = analyzePcm16Wav(sineWav({ frequency: 220 }))
  assert.ok(Math.abs(low.objective.estimatedMedianPitchHz - 100) < 5)
  assert.ok(Math.abs(high.objective.estimatedMedianPitchHz - 220) < 10)
  assert.equal(low.objective.clippedSampleFraction, 0)
  assert.equal(low.objective.activeFrameFraction, 1)
  assert.ok(high.objective.zeroCrossingsPerSecond > low.objective.zeroCrossingsPerSecond)
})

test('review derivation requires deterministic references, fixed reuse, serialized-line repeats, and healthy audio', async () => {
  const { lock, references, outputs } = await passingFixture()
  const review = deriveObjectiveReview(lock, references, outputs)
  assert.ok(Object.values(review.checks).every(Boolean))
  assert.equal(review.decision.result, 'GO for synthetic bootstrap technical feasibility')
  assert.match(review.decision.productionReadiness, /NOT ASSESSED/u)
  assert.match(review.intelligibilityProxy.limitation, /listening review/u)

  const changed = structuredClone(outputs)
  changed[0].referenceSha256 = 'f'.repeat(64)
  const rejected = deriveObjectiveReview(lock, references, changed)
  assert.equal(rejected.checks.fixedReferenceReused, false)
  assert.match(rejected.decision.result, /^NO-GO/u)
})

test('manual review is transcript-aligned, unrated, and cannot imply listening approval', async () => {
  const { lock, references, outputs } = await passingFixture()
  const objective = deriveObjectiveReview(lock, references, outputs)
  const manual = createManualReview(lock, outputs, objective)
  assert.equal(manual.status, 'pending')
  assert.equal(manual.reviewer, null)
  assert.equal(manual.listeningApproval, null)
  assert.equal(manual.candidates.length, 3)
  assert.ok(manual.candidates.every(({ lines }) => lines.length === 3))
  assert.ok(
    manual.candidates
      .flatMap(({ lines }) => lines)
      .every(({ intelligibility }) => intelligibility === null),
  )
})

test('operational harness is external, immutable, loopback-only, serialized, and non-streaming', async () => {
  const shell = await readFile(join(root, 'scripts/synthetic-voice-bootstrap.sh'), 'utf8')
  const probe = await readFile(join(root, 'scripts/probe-synthetic-voices.mjs'), 'utf8')
  assert.match(shell, /USE_MBROLA=OFF/u)
  assert.match(shell, /USE_LIBSONIC=OFF/u)
  assert.match(shell, /CMAKE_INSTALL_PREFIX/u)
  assert.match(shell, /immutable install target appeared during build/u)
  assert.match(shell, /voice-selection/u)
  assert.match(shell, /installed voice selection mismatch/u)
  assert.match(shell, /source_identity/u)
  assert.match(shell, /artifact roots overlap/u)
  assert.match(probe, /flag: 'wx'/u)
  assert.match(probe, /inFlight !== 0/u)
  assert.match(probe, /maximumInFlight !== 1/u)
  assert.match(probe, /exactLoopbackListener/u)
  assert.match(probe, /evidence output already exists/u)
  assert.match(probe, /fixed-buffer limit/u)
  assert.match(probe, /candidate-separated generation passes/u)
  assert.doesNotMatch(probe, /\/v1\/audio\/speech\/stream/u)
  assert.doesNotMatch(`${shell}\n${probe}`, /--host['"\s,]+0\.0\.0\.0/u)
})

test('committed host evidence, when present, remains sanitized and non-production', async () => {
  const evidencePath = join(root, 'docs/evidence/issue-8-synthetic-voices-wsl2.json')
  let evidence
  try {
    evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  assert.equal(evidence.issue, 8)
  assert.equal(evidence.candidates.length, 3)
  assert.equal(evidence.isolation.maximumInFlightRequests, 1)
  assert.equal(evidence.isolation.allRequestsNonStreaming, true)
  assert.equal(evidence.provenance.humanOrCopyrightedReferenceAudioUsed, false)
  assert.equal(evidence.review.manualReady.status, 'pending')
  assert.match(evidence.decision.result, /^GO for synthetic bootstrap/u)
  assert.match(evidence.decision.productionReadiness, /NOT ASSESSED/u)
  assert.doesNotMatch(JSON.stringify(evidence), /\/(?:home|mnt)\//u)
})
