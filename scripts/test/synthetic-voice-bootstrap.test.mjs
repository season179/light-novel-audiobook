import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  analyzePcm16Wav,
  createManualReview,
  deriveObjectiveReview,
  directoryTreeHash,
  loadBootstrapLock,
  stableJsonHash,
  validateApprovedVoxIdentity,
} from '../synthetic-voices/core.mjs'
import { deriveSourceIdentity, sha256 } from '../voxcpm2/core.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const lockPath = join(root, 'config/synthetic-voice-bootstrap.lock.json')

function gitShow(commit, path) {
  const result = spawnSync('git', ['-C', root, 'show', `${commit}:${path}`])
  if (result.status !== 0) throw new Error(`cannot read historical source ${commit}:${path}`)
  return result.stdout
}

function verifyHistoricalSourceIdentity(evidence, sourcePaths) {
  const commit = evidence.provenance.generatedFromCommit
  const commitCheck = spawnSync('git', ['-C', root, 'cat-file', '-e', `${commit}^{commit}`])
  assert.equal(commitCheck.status, 0, 'generatedFromCommit must exist')
  const recomputed = {}
  for (const [name, path] of Object.entries(sourcePaths)) {
    recomputed[name] = sha256(gitShow(commit, path))
  }
  assert.deepEqual(evidence.provenance.sourceHashes, recomputed)
  const identity = deriveSourceIdentity(recomputed)
  if (evidence.provenance.sourceIdentity !== undefined) {
    assert.equal(evidence.provenance.sourceIdentity, identity)
  }
  assert.equal(evidence.run.sourceIdentity, identity)
  return JSON.parse(gitShow(commit, sourcePaths.config))
}

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

function mockAnalysis(pitch, hash, durationSeconds = 3) {
  return {
    audio: { durationSeconds, sha256: hash },
    objective: {
      clippedSampleFraction: 0,
      activeFrameFraction: 0.95,
      estimatedMedianPitchHz: pitch,
      rmsDbfs: -18,
    },
  }
}

function expectedParameters(lock) {
  return {
    model: lock.generation.model,
    responseFormat: lock.generation.responseFormat,
    cfgValue: lock.generation.cfgValue,
    temperature: lock.generation.temperature,
    inferenceTimesteps: lock.generation.inferenceTimesteps,
    maxSteps: lock.generation.maxSteps,
  }
}

async function passingFixture() {
  const lock = await loadBootstrapLock(lockPath)
  const pitches = [100, 140, 210]
  const references = lock.candidates.map((candidate, index) => {
    const hash = `${index + 1}`.repeat(64)
    return {
      candidateId: candidate.id,
      role: candidate.role,
      voice: candidate.voice,
      transcript: candidate.transcript,
      transcriptSha256: candidate.transcriptSha256,
      seed: candidate.seed,
      parameters: candidate.parameters,
      file: `references/${candidate.id}/reference.wav`,
      repeatFile: `references/${candidate.id}/reference-repeat.wav`,
      sha256: hash,
      repeatSha256: hash,
      analysis: mockAnalysis(pitches[index], hash, 7),
    }
  })
  const outputs = []
  let sequence = 0
  for (const [candidateIndex, candidate] of lock.candidates.entries()) {
    for (const line of lock.lines) {
      const hash = sha256(`${candidate.id}:${line.id}`)
      sequence += 1
      outputs.push({
        sequence,
        candidateId: candidate.id,
        lineId: line.id,
        repetition: 0,
        text: line.text,
        textSha256: line.textSha256,
        seed: line.seed,
        parameters: expectedParameters(lock),
        referenceSha256: references[candidateIndex].sha256,
        sha256: hash,
        analysis: mockAnalysis(pitches[candidateIndex], hash, 3),
        file: `outputs/${candidate.id}/${line.id}.wav`,
        status: 200,
        contentType: 'audio/wav',
      })
    }
    const repeated = outputs.find(
      ({ candidateId, lineId }) =>
        candidateId === candidate.id && lineId === lock.generation.repeatLineId,
    )
    sequence += 1
    outputs.push({
      ...structuredClone(repeated),
      sequence,
      repetition: 1,
      file: repeated.file.replace('.wav', '-repeat.wav'),
    })
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
  assert.equal(
    lock.voxcpm2.approvedBuild.serverBinarySha256,
    '89e89900c8fb8a03438218c1fc5130c719b82738bf1cc91b3039e4684b28e6ac',
  )
  assert.equal(lock.reviewGates.maximumCrossLinePitchCoefficientOfVariation, 0.15)
  assert.equal(stableJsonHash(lock.espeakNg.build).length, 64)
})

test('approved VoxCPM2 identity rejects source, CMake, manifest, evidence, and binary substitution', async () => {
  const lock = await loadBootstrapLock(lockPath)
  const issue7Buffer = await readFile(join(root, lock.voxcpm2.issue7EvidencePath))
  const issue7Evidence = JSON.parse(issue7Buffer)
  const buildManifest = structuredClone(issue7Evidence.build.manifest)
  const approved = lock.voxcpm2.approvedBuild
  const actual = {
    issue7EvidenceSha256: sha256(issue7Buffer),
    buildManifestSha256: approved.manifestSha256,
    runtimeRevision: approved.runtimeRevision,
    runtimeTree: approved.runtimeTree,
    cmakeCacheSha256: approved.cmakeCacheSha256,
    buildMetadataSha256: approved.buildMetadataSha256,
    serverBinarySha256: approved.serverBinarySha256,
  }
  assert.equal(
    validateApprovedVoxIdentity(lock, issue7Evidence, buildManifest, actual)
      .independentlyMatchedIssue7EvidenceAndExternalBuild,
    true,
  )
  for (const field of [
    'issue7EvidenceSha256',
    'buildManifestSha256',
    'runtimeRevision',
    'runtimeTree',
    'cmakeCacheSha256',
    'buildMetadataSha256',
    'serverBinarySha256',
  ]) {
    assert.throws(
      () =>
        validateApprovedVoxIdentity(lock, issue7Evidence, buildManifest, {
          ...actual,
          [field]: field.includes('Revision') ? '0'.repeat(40) : '0'.repeat(64),
        }),
      /approved build identity mismatch/u,
      field,
    )
  }
  const substitutedEvidence = structuredClone(issue7Evidence)
  substitutedEvidence.decision.result = 'GO'
  assert.throws(
    () => validateApprovedVoxIdentity(lock, substitutedEvidence, buildManifest, actual),
    /issue7 decision/u,
  )
  const substitutedManifest = structuredClone(buildManifest)
  substitutedManifest.binaries['llama-tts-server'] = '0'.repeat(64)
  assert.throws(
    () => validateApprovedVoxIdentity(lock, issue7Evidence, substitutedManifest, actual),
    /manifest server binary/u,
  )
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

test('review rejects adversarial matrix, identity, hash, parameter, and stability substitutions', async () => {
  const fixture = await passingFixture()
  const outputCases = [
    [
      'duplicate primary key',
      'primaryMatrixExact',
      (items) => {
        items[1].lineId = items[0].lineId
      },
    ],
    ['missing output', 'outputExactMatrix', (items) => items.pop()],
    [
      'extra candidate ID',
      'outputExactMatrix',
      (items) => {
        items[0].candidateId = 'intruder'
      },
    ],
    [
      'extra line ID',
      'outputExactMatrix',
      (items) => {
        items[0].lineId = 'line-extra'
      },
    ],
    [
      'wrong repeat line',
      'repeatMatrixExact',
      (items) => {
        items.find(({ repetition }) => repetition === 1).lineId = 'line-02'
      },
    ],
    [
      'duplicate repeat',
      'outputExactMatrix',
      (items) => {
        items.push(structuredClone(items.find(({ repetition }) => repetition === 1)))
      },
    ],
    [
      'text substitution',
      'outputIdentity',
      (items) => {
        items[0].text = 'substituted'
      },
    ],
    [
      'text hash substitution',
      'outputIdentity',
      (items) => {
        items[0].textSha256 = 'f'.repeat(64)
      },
    ],
    [
      'seed substitution',
      'outputIdentity',
      (items) => {
        items[0].seed += 1
      },
    ],
    [
      'model substitution',
      'outputIdentity',
      (items) => {
        items[0].parameters.model = 'substitute'
      },
    ],
    [
      'parameter substitution',
      'outputIdentity',
      (items) => {
        items[0].parameters.cfgValue = 999
      },
    ],
    [
      'reference substitution',
      'outputIdentity',
      (items) => {
        items[0].referenceSha256 = 'f'.repeat(64)
      },
    ],
    [
      'file substitution',
      'outputIdentity',
      (items) => {
        items[0].file = 'outputs/wrong.wav'
      },
    ],
    [
      'sequence substitution',
      'outputIdentity',
      (items) => {
        items[0].sequence = 12
      },
    ],
    [
      'conditioned hash collision',
      'conditionedPrimaryHashesDistinct',
      (items) => {
        const primary = items.filter(({ repetition }) => repetition === 0)
        primary[3].sha256 = primary[0].sha256
        primary[3].analysis.audio.sha256 = primary[0].sha256
      },
    ],
    [
      'cross-line pitch drift',
      'crossLinePitchStable',
      (items) => {
        const primary = items.filter(
          ({ candidateId, repetition }) => candidateId === 'narrator' && repetition === 0,
        )
        for (const [index, pitch] of [70, 100, 140].entries()) {
          primary[index].analysis.objective.estimatedMedianPitchHz = pitch
        }
      },
    ],
  ]
  for (const [name, expectedCheck, mutate] of outputCases) {
    const outputs = structuredClone(fixture.outputs)
    mutate(outputs)
    const review = deriveObjectiveReview(fixture.lock, fixture.references, outputs)
    assert.equal(review.checks[expectedCheck], false, name)
    assert.match(review.decision.result, /^NO-GO/u, name)
  }

  const referenceCases = [
    [
      'duplicate candidate reference',
      (items) => {
        items[1].candidateId = items[0].candidateId
      },
    ],
    ['missing candidate reference', (items) => items.pop()],
    ['extra candidate reference', (items) => items.push(structuredClone(items[0]))],
    [
      'reference transcript substitution',
      (items) => {
        items[0].transcript = 'substituted'
      },
    ],
    [
      'reference parameter substitution',
      (items) => {
        items[0].parameters.pitch += 1
      },
    ],
    [
      'reference file substitution',
      (items) => {
        items[0].file = 'references/wrong.wav'
      },
    ],
  ]
  for (const [name, mutate] of referenceCases) {
    const references = structuredClone(fixture.references)
    mutate(references)
    const review = deriveObjectiveReview(fixture.lock, references, fixture.outputs)
    assert.equal(Object.values(review.checks).every(Boolean), false, name)
    assert.match(review.decision.result, /^NO-GO/u, name)
  }
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
  assert.match(shell, /issue #7 evidence checksum mismatch/u)
  assert.match(shell, /VOXCPM2_BUILD_MANIFEST/u)
  assert.match(shell, /source_identity/u)
  assert.match(shell, /artifact roots overlap/u)
  assert.match(probe, /flag: 'wx'/u)
  assert.match(probe, /inFlight !== 0/u)
  assert.match(probe, /maximumInFlight !== 1/u)
  assert.match(probe, /exactLoopbackListener/u)
  assert.match(probe, /evidence output already exists/u)
  assert.match(probe, /fixed-buffer limit/u)
  assert.match(probe, /candidate-separated generation passes/u)
  assert.match(probe, /validateApprovedVoxIdentity/u)
  assert.match(probe, /review-instructions\.txt/u)
  assert.doesNotMatch(probe, /\/v1\/audio\/speech\/stream/u)
  assert.doesNotMatch(`${shell}\n${probe}`, /--host['"\s,]+0\.0\.0\.0/u)
})

test('latest committed evidence deeply recomputes historical provenance, matrices, and decision', async () => {
  const evidencePath = join(root, 'docs/evidence/issue-8-synthetic-voices-wsl2-v2.json')
  let evidence
  try {
    evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  const historicalLock = verifyHistoricalSourceIdentity(evidence, {
    config: 'config/synthetic-voice-bootstrap.lock.json',
    core: 'scripts/synthetic-voices/core.mjs',
    issue7Evidence: 'docs/evidence/issue-7-voxcpm2-wsl2.json',
    probe: 'scripts/probe-synthetic-voices.mjs',
    shell: 'scripts/synthetic-voice-bootstrap.sh',
    voxConfig: 'config/voxcpm2-spike.lock.json',
    voxCore: 'scripts/voxcpm2/core.mjs',
  })
  assert.equal(evidence.provenance.configurationSha256, evidence.provenance.sourceHashes.config)
  assert.equal(evidence.issue, 8)
  assert.equal(evidence.candidates.length, historicalLock.candidates.length)
  for (const candidate of historicalLock.candidates) {
    assert.equal(sha256(candidate.transcript), candidate.transcriptSha256)
  }
  for (const line of historicalLock.lines) assert.equal(sha256(line.text), line.textSha256)
  const recomputedReview = deriveObjectiveReview(
    historicalLock,
    evidence.candidates,
    evidence.voxcpm2Outputs,
  )
  assert.ok(Object.values(recomputedReview.checks).every(Boolean))
  assert.deepEqual(evidence.review.objective, recomputedReview)
  assert.deepEqual(evidence.decision, recomputedReview.decision)
  assert.equal(evidence.isolation.maximumInFlightRequests, 1)
  assert.equal(evidence.isolation.allRequestsNonStreaming, true)
  assert.equal(evidence.provenance.humanOrCopyrightedReferenceAudioUsed, false)
  assert.equal(evidence.review.manualReady.status, 'pending')
  assert.equal(evidence.review.manualReady.closureGate, 'REQUIRED human listening; not completed')
  assert.match(evidence.decision.productionReadiness, /NOT ASSESSED/u)
  assert.doesNotMatch(JSON.stringify(evidence), /\/(?:home|mnt)\//u)

  const issue7Buffer = await readFile(join(root, historicalLock.voxcpm2.issue7EvidencePath))
  const issue7Evidence = JSON.parse(issue7Buffer)
  verifyHistoricalSourceIdentity(issue7Evidence, {
    config: 'config/voxcpm2-spike.lock.json',
    core: 'scripts/voxcpm2/core.mjs',
    probe: 'scripts/probe-voxcpm2.mjs',
    shell: 'scripts/voxcpm2-spike.sh',
  })
  const approval = evidence.provenance.voxcpm2.runtimeApproval
  validateApprovedVoxIdentity(historicalLock, issue7Evidence, issue7Evidence.build.manifest, {
    issue7EvidenceSha256: sha256(issue7Buffer),
    buildManifestSha256: approval.buildManifestSha256,
    runtimeRevision: approval.runtimeRevision,
    runtimeTree: approval.runtimeTree,
    cmakeCacheSha256: approval.cmakeCacheSha256,
    buildMetadataSha256: approval.buildMetadataSha256,
    serverBinarySha256: approval.serverBinarySha256,
  })
})

test('stableJsonHash orders keys by code point, not locale (#63)', () => {
  // 'typing-inspection' (- U+002D) < 'typing_extensions' (_ U+005F) by code point; localeCompare
  // reverses them, changing the canonical JSON and therefore the hash.
  const value = { 'typing-inspection': 1, typing_extensions: 2 }
  const expected = sha256(JSON.stringify({ 'typing-inspection': 1, typing_extensions: 2 }))
  assert.equal(stableJsonHash(value), expected)
})

test('directoryTreeHash orders paths by code point, not locale (#63)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dth-locale-'))
  await writeFile(join(dir, 'typing-inspection'), 'aaa')
  await writeFile(join(dir, 'typing_extensions'), 'bbbbb')
  // code-point order: typing-inspection (- U+002D) before typing_extensions (_ U+005F)
  const first = createHash('sha256').update('aaa').digest('hex')
  const second = createHash('sha256').update('bbbbb').digest('hex')
  const expected = createHash('sha256')
    .update(`typing-inspection\u0000${first}\n`)
    .update(`typing_extensions\u0000${second}\n`)
    .digest('hex')
  assert.equal(await directoryTreeHash(dir), expected)
})
