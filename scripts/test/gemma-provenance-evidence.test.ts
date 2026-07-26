import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  assertGemmaProvenanceEvidence,
  GemmaProvenanceEvidenceError,
} from '../gemma-provenance-evidence.mjs'

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const EVIDENCE_PATH = path.join(
  REPOSITORY_ROOT,
  'docs/evidence/issue-21-gemma-provenance-real.json',
)

const loadEvidence = async () => JSON.parse(await readFile(EVIDENCE_PATH, 'utf8'))

const clone = <Value>(value: Value): Value => structuredClone(value)

describe('committed real Gemma provenance', () => {
  it('strictly validates the committed content-free process/request/flock evidence', async () => {
    expect(assertGemmaProvenanceEvidence(await loadEvidence())).toBeDefined()
  })

  it('rejects evidence with zero served director requests', async () => {
    const mutated = clone(await loadEvidence())
    mutated.directorRequests = []
    mutated.assertions.directorRequestCount = 0

    expect(() => assertGemmaProvenanceEvidence(mutated)).toThrow(GemmaProvenanceEvidenceError)
  })

  it('rejects overlapping Gemma and Qwen flock intervals', async () => {
    const mutated = clone(await loadEvidence())
    mutated.kernelFlockIntervals[1].startedAtMonotonicNs =
      mutated.kernelFlockIntervals[0].startedAtMonotonicNs

    expect(() => assertGemmaProvenanceEvidence(mutated)).toThrow(
      'Gemma and Qwen flock intervals overlap',
    )
  })

  it('rejects any request receipt that grows a message body field', async () => {
    const mutated = clone(await loadEvidence())
    mutated.directorRequests[0].messageBody = 'prose must never enter evidence'

    expect(() => assertGemmaProvenanceEvidence(mutated)).toThrow('director request 1 fields are')
  })
})
