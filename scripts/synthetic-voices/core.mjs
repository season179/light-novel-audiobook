import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { parseWav, sha256, sha256File } from '../voxcpm2/core.mjs'

const SHA256 = /^[0-9a-f]{64}$/u
const REVISION = /^[0-9a-f]{40}$/u

export async function loadBootstrapLock(path) {
  const lock = JSON.parse(await readFile(path, 'utf8'))
  if (lock.schemaVersion !== 1 || lock.issue !== 8) throw new Error('unsupported bootstrap lock')
  if (!REVISION.test(lock.espeakNg?.revision) || !REVISION.test(lock.espeakNg?.sourceTree)) {
    throw new Error('invalid eSpeak NG revision')
  }
  const hashes = [
    lock.espeakNg.licenseSha256,
    lock.espeakNg.readmeSha256,
    lock.espeakNg.voiceDocumentationSha256,
    lock.voxcpm2.lockSha256,
    ...lock.espeakNg.voiceSources.map((source) => source.sha256),
  ]
  if (hashes.some((hash) => !SHA256.test(hash))) throw new Error('invalid pinned SHA-256')
  if (lock.espeakNg.license !== 'GPL-3.0-or-later') throw new Error('unexpected eSpeak license')
  if (lock.espeakNg.build.mbrola !== false) throw new Error('MBROLA must be disabled')
  if (lock.voxcpm2.mode !== 'serialized-non-streaming-experimental-only') {
    throw new Error('VoxCPM2 mode violates issue #7')
  }
  if (lock.voxcpm2.endpointPath !== '/v1/audio/speech') {
    throw new Error('only the non-streaming speech endpoint is allowed')
  }
  if (lock.candidates.length !== 3 || new Set(lock.candidates.map(({ id }) => id)).size !== 3) {
    throw new Error('exactly three unique candidates are required')
  }
  if (lock.candidates.filter(({ role }) => role === 'narrator').length !== 1) {
    throw new Error('exactly one narrator is required')
  }
  if (lock.candidates.filter(({ role }) => role === 'character').length !== 2) {
    throw new Error('exactly two characters are required')
  }
  for (const candidate of lock.candidates) {
    if (candidate.seed !== null) throw new Error('eSpeak NG has no stochastic seed')
    if (sha256(candidate.transcript) !== candidate.transcriptSha256) {
      throw new Error(`candidate transcript hash mismatch: ${candidate.id}`)
    }
    if (!/^en-us(?:\+(?:m3|f4))?$/u.test(candidate.voice)) {
      throw new Error(`candidate is not an approved formant voice: ${candidate.id}`)
    }
    for (const value of Object.values(candidate.parameters)) {
      if (!Number.isInteger(value) || value <= 0) throw new Error('invalid eSpeak parameter')
    }
  }
  if (lock.lines.length < 2) throw new Error('multiple fixed VoxCPM2 lines are required')
  for (const line of lock.lines) {
    if (sha256(line.text) !== line.textSha256 || !Number.isInteger(line.seed)) {
      throw new Error(`line provenance mismatch: ${line.id}`)
    }
  }
  if (!lock.lines.some(({ id }) => id === lock.generation.repeatLineId)) {
    throw new Error('repeat line is not in the fixed line set')
  }
  return lock
}

export function stableJsonHash(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize)
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      )
    }
    return item
  }
  return sha256(JSON.stringify(normalize(value)))
}

export async function directoryTreeHash(root) {
  const files = []
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  await visit(root)
  files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)))
  const digest = createHash('sha256')
  for (const path of files) {
    digest.update(`${relative(root, path)}\0${await sha256File(path)}\n`)
  }
  return digest.digest('hex')
}

function pcm16Samples(buffer, info) {
  if (info.encoding !== 'PCM' || info.channels !== 1 || info.bitsPerSample !== 16) {
    throw new Error('objective analysis requires mono 16-bit PCM')
  }
  const samples = new Int16Array(info.frames)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = buffer.readInt16LE(info.dataOffset + index * 2)
  }
  return samples
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function estimatePitchHz(samples, sampleRateHz) {
  const stride = Math.max(1, Math.round(sampleRateHz / 8000))
  const rate = sampleRateHz / stride
  const frameLength = Math.round(rate * 0.04)
  const hop = Math.round(rate * 0.02)
  const minimumLag = Math.floor(rate / 350)
  const maximumLag = Math.ceil(rate / 65)
  const pitches = []
  for (
    let sourceStart = 0;
    sourceStart + frameLength * stride < samples.length;
    sourceStart += hop * stride
  ) {
    const frame = new Float64Array(frameLength)
    let mean = 0
    for (let index = 0; index < frameLength; index += 1) {
      frame[index] = samples[sourceStart + index * stride]
      mean += frame[index]
    }
    mean /= frameLength
    let energy = 0
    for (let index = 0; index < frameLength; index += 1) {
      frame[index] -= mean
      energy += frame[index] ** 2
    }
    if (Math.sqrt(energy / frameLength) < 300) continue
    const scores = []
    let best = 0
    for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
      let product = 0
      let leftEnergy = 0
      let rightEnergy = 0
      for (let index = 0; index < frameLength - lag; index += 1) {
        const left = frame[index]
        const right = frame[index + lag]
        product += left * right
        leftEnergy += left * left
        rightEnergy += right * right
      }
      const score = product / Math.sqrt(leftEnergy * rightEnergy || 1)
      scores[lag] = score
      if (score > best) best = score
    }
    if (best < 0.35) continue
    let selectedLag = minimumLag
    for (let lag = minimumLag + 1; lag < maximumLag; lag += 1) {
      if (
        scores[lag] >= best * 0.9 &&
        scores[lag] >= scores[lag - 1] &&
        scores[lag] >= scores[lag + 1]
      ) {
        selectedLag = lag
        break
      }
      if (scores[lag] === best) selectedLag = lag
    }
    pitches.push(rate / selectedLag)
  }
  return median(pitches)
}

export function analyzePcm16Wav(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const audio = parseWav(buffer)
  const samples = pcm16Samples(buffer, audio)
  let squareTotal = 0
  let peak = 0
  let clipped = 0
  let crossings = 0
  for (let index = 0; index < samples.length; index += 1) {
    const absolute = Math.abs(samples[index])
    peak = Math.max(peak, absolute)
    squareTotal += samples[index] ** 2
    if (absolute >= 32760) clipped += 1
    if (index > 0 && Math.sign(samples[index]) !== Math.sign(samples[index - 1])) crossings += 1
  }
  const frameLength = Math.max(1, Math.round(audio.sampleRateHz * 0.02))
  let activeFrames = 0
  let frameCount = 0
  for (let start = 0; start < samples.length; start += frameLength) {
    let frameSquareTotal = 0
    const end = Math.min(samples.length, start + frameLength)
    for (let index = start; index < end; index += 1) frameSquareTotal += samples[index] ** 2
    const frameRms = Math.sqrt(frameSquareTotal / (end - start))
    if (frameRms / 32768 > 10 ** (-50 / 20)) activeFrames += 1
    frameCount += 1
  }
  const rms = Math.sqrt(squareTotal / samples.length)
  return {
    audio,
    objective: {
      peakDbfs: peak === 0 ? null : 20 * Math.log10(peak / 32768),
      rmsDbfs: rms === 0 ? null : 20 * Math.log10(rms / 32768),
      clippedSampleFraction: clipped / samples.length,
      activeFrameFraction: activeFrames / frameCount,
      zeroCrossingsPerSecond: crossings / audio.durationSeconds,
      estimatedMedianPitchHz: estimatePitchHz(samples, audio.sampleRateHz),
    },
  }
}

function coefficientOfVariation(values) {
  const finite = values.filter(Number.isFinite)
  if (finite.length < 2) return null
  const mean = finite.reduce((total, value) => total + value, 0) / finite.length
  const variance = finite.reduce((total, value) => total + (value - mean) ** 2, 0) / finite.length
  return Math.sqrt(variance) / mean
}

export function deriveObjectiveReview(lock, references, outputs) {
  const gates = lock.reviewGates
  const referenceById = new Map(references.map((reference) => [reference.candidateId, reference]))
  const referenceRepeatable = references.every(
    (reference) => reference.sha256 === reference.repeatSha256,
  )
  const referenceAudioHealthy = references.every(
    ({ analysis }) =>
      analysis.objective.clippedSampleFraction <= gates.maximumClippedSampleFraction &&
      analysis.objective.activeFrameFraction >= gates.minimumActiveFrameFraction &&
      Number.isFinite(analysis.objective.estimatedMedianPitchHz),
  )
  const pairwiseReferencePitchRatios = []
  for (let left = 0; left < references.length; left += 1) {
    for (let right = left + 1; right < references.length; right += 1) {
      const leftPitch = references[left].analysis.objective.estimatedMedianPitchHz
      const rightPitch = references[right].analysis.objective.estimatedMedianPitchHz
      pairwiseReferencePitchRatios.push({
        candidates: [references[left].candidateId, references[right].candidateId],
        ratio: Math.max(leftPitch, rightPitch) / Math.min(leftPitch, rightPitch),
      })
    }
  }
  const referencesDistinguishable = pairwiseReferencePitchRatios.every(
    ({ ratio }) => ratio >= gates.minimumReferencePitchRatio,
  )
  const expectedOutputCount = lock.candidates.length * (lock.lines.length + 1)
  const fixedReferenceReused = outputs.every(
    (output) => output.referenceSha256 === referenceById.get(output.candidateId)?.sha256,
  )
  const outputAudioHealthy = outputs.every(({ analysis, text, repetition }) => {
    const words = text.trim().split(/\s+/u).length
    const secondsPerWord = analysis.audio.durationSeconds / words
    return (
      analysis.objective.clippedSampleFraction <= gates.maximumClippedSampleFraction &&
      analysis.objective.activeFrameFraction >= gates.minimumActiveFrameFraction &&
      secondsPerWord >= gates.minimumOutputSecondsPerWord &&
      secondsPerWord <= gates.maximumOutputSecondsPerWord &&
      (repetition === 0 || repetition === 1)
    )
  })
  const voxcpmRepeatable = lock.candidates.every((candidate) => {
    const repeated = outputs.filter(
      ({ candidateId, lineId }) =>
        candidateId === candidate.id && lineId === lock.generation.repeatLineId,
    )
    return repeated.length === 2 && repeated[0].sha256 === repeated[1].sha256
  })
  const crossLineConsistency = lock.candidates.map((candidate) => {
    const primary = outputs.filter(
      ({ candidateId, repetition }) => candidateId === candidate.id && repetition === 0,
    )
    return {
      candidateId: candidate.id,
      validLineCount: primary.length,
      referenceSha256: referenceById.get(candidate.id)?.sha256,
      durationSeconds: primary.map(({ analysis }) => analysis.audio.durationSeconds),
      pitchCoefficientOfVariation: coefficientOfVariation(
        primary.map(({ analysis }) => analysis.objective.estimatedMedianPitchHz),
      ),
      rmsDbfsRange: [
        Math.min(...primary.map(({ analysis }) => analysis.objective.rmsDbfs)),
        Math.max(...primary.map(({ analysis }) => analysis.objective.rmsDbfs)),
      ],
    }
  })
  const checks = {
    candidateCount: references.length === 3,
    referenceRepeatable,
    referenceAudioHealthy,
    referencesDistinguishable,
    outputCount: outputs.length === expectedOutputCount,
    fixedReferenceReused,
    outputAudioHealthy,
    voxcpmRepeatable,
  }
  const technicalFeasibility = Object.values(checks).every(Boolean)
  return {
    checks,
    pairwiseReferencePitchRatios,
    crossLineConsistency,
    intelligibilityProxy: {
      method: 'valid PCM, active-speech fraction, clipping, and duration-per-word bounds',
      passed: outputAudioHealthy,
      limitation:
        'These objective bounds do not establish word accuracy; transcript-aligned listening review remains required.',
    },
    decision: {
      result: technicalFeasibility
        ? 'GO for synthetic bootstrap technical feasibility'
        : 'NO-GO for synthetic bootstrap technical feasibility',
      productionReadiness: 'NOT ASSESSED; issue #7 remains NO-GO for production SpeechEngine/M2',
      listeningApproval: 'PENDING manual review',
      requiredLocalEngine: 'Pinned eSpeak NG 1.52.0 formant synthesis with MBROLA disabled',
    },
  }
}

export function createManualReview(lock, outputs, objectiveReview) {
  return {
    schemaVersion: 1,
    status: 'pending',
    instructions:
      'Listen on ordinary headphones. Compare each WAV with its exact project-authored transcript. Set every null rating and add reviewer/date before any listening approval.',
    scales: {
      intelligibility: '1 unintelligible; 3 understandable with errors; 5 every word clear',
      stability: '1 severe artifacts/dropouts; 3 minor artifacts; 5 stable throughout',
      crossLineConsistency: '1 different identity; 3 broadly similar; 5 clearly the same identity',
    },
    issue7Restriction:
      'Experimental serialized non-streaming output only; not production/M2 evidence.',
    objectiveDecision: objectiveReview.decision,
    candidates: lock.candidates.map((candidate) => ({
      candidateId: candidate.id,
      role: candidate.role,
      referenceTranscript: candidate.transcript,
      lines: outputs
        .filter(({ candidateId, repetition }) => candidateId === candidate.id && repetition === 0)
        .map(({ file, lineId, text, sha256: outputSha256 }) => ({
          file,
          lineId,
          transcript: text,
          outputSha256,
          intelligibility: null,
          stability: null,
          notes: null,
        })),
      distinguishableFromOtherCandidates: null,
      crossLineConsistency: null,
      notes: null,
    })),
    reviewer: null,
    reviewedAt: null,
    listeningApproval: null,
  }
}

export async function hashStream(path) {
  const hash = createHash('sha256')
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('end', resolvePromise)
    stream.once('error', reject)
  })
  return hash.digest('hex')
}
