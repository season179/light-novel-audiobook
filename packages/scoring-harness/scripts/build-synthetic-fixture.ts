import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalSha256, sha256 } from '../src/canonical-json.js'
import type {
  EvaluationRun,
  EvaluationSource,
  GoldAnnotations,
  RepresentativeCorpus,
  SelectionCriterion,
} from '../src/schemas.js'
import { RepresentativeCorpusScorer } from '../src/scorer.js'

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test/fixtures')
const zeroHash = sha256('synthetic-placeholder')
const cases: RepresentativeCorpus['cases'][number][] = []
const passages: EvaluationSource['passages'][number][] = []

function caseCriteria(caseNumber: number): SelectionCriterion[] {
  const criteria: SelectionCriterion[] = []
  if (caseNumber <= 21) criteria.push('dialogue')
  if (caseNumber <= 20) criteria.push(caseNumber % 2 === 0 ? 'coreference' : 'alias')
  if (caseNumber === 21) criteria.push('ambiguous_speaker')
  if (caseNumber >= 22 && caseNumber <= 50) criteria.push('internal_thought')
  if (caseNumber >= 51) criteria.push('narration')
  if (caseNumber === 51) criteria.push('structurally_ambiguous')
  if (caseNumber === 3 || caseNumber === 4) criteria.push('repeated_text')
  if (caseNumber === 1 || caseNumber === 2) criteria.push('source_reference')
  return criteria
}

function addPassage(sourceRef: string, sourceText: string, caseNumbers: readonly number[]): void {
  passages.push({
    source_ref: sourceRef,
    locator: `spine[0000]::EPUB/synthetic.xhtml::/html[1]/body[1]/p[${passages.length + 1}]`,
    source_text: sourceText,
    source_text_sha256: sha256(sourceText),
  })
  let cursor = 0
  for (const [index, caseNumber] of caseNumbers.entries()) {
    const length =
      index === caseNumbers.length - 1
        ? Array.from(sourceText).length - cursor
        : Math.floor(Array.from(sourceText).length / caseNumbers.length)
    cases.push({
      case_id: `case-${String(caseNumber).padStart(3, '0')}`,
      source_ref: sourceRef,
      source_start: cursor,
      source_end: cursor + length,
      legitimate: true,
      criteria: caseCriteria(caseNumber),
    })
    cursor += length
  }
}

addPassage('source-ref-001', 'The brass bell rang.The brass bell rang.', [1, 2])
for (let caseNumber = 3; caseNumber <= 60; caseNumber += 1) {
  const sourceText =
    caseNumber === 3 || caseNumber === 4
      ? 'The lantern blinked twice.'
      : `Original synthetic benchmark line ${String(caseNumber).padStart(3, '0')}.`
  addPassage(`source-ref-${String(caseNumber - 1).padStart(3, '0')}`, sourceText, [caseNumber])
}

const publicationHash = canonicalSha256(passages)
const source: EvaluationSource = {
  schema_version: 'evaluation-source@1',
  source_version: 'synthetic-representative-source@1',
  source_id: 'issue-4-synthetic-analogue',
  provenance: {
    origin: 'project_synthetic',
    redistribution: 'committed_allowed',
    license: 'CC0-1.0',
    contains_personal_data: false,
  },
  extraction_identity: {
    archive_parser: 'synthetic-fixture-builder@1',
    xml_parser: 'synthetic-fixture-builder@1',
    extraction_rules: 'epub-source-text@2',
    publication_content_sha256: publicationHash,
    extraction_sha256: sha256(`synthetic-extraction@1\0${publicationHash}`),
    offset_unit: 'unicode-scalar-value',
  },
  passages,
}
const sourceHash = canonicalSha256(source)
const corpus: RepresentativeCorpus = {
  schema_version: 'representative-corpus@1',
  corpus_version: 'synthetic-representative-corpus@1',
  corpus_id: 'issue-4-synthetic-analogue',
  source_sha256: sourceHash,
  storage_class: 'committed_synthetic',
  selection_policy_version: 'representative-selection@1',
  selection_rationale:
    'Synthetic cases cover every required semantic and structural evaluation dimension.',
  cases,
}
const corpusHash = canonicalSha256(corpus)
const annotations: GoldAnnotations = {
  schema_version: 'gold-annotations@1',
  annotation_version: 'synthetic-gold@1',
  annotation_policy_version: 'gold-annotation-policy@1',
  source_sha256: sourceHash,
  corpus_sha256: corpusHash,
  cases: cases.map((item, index) => {
    const caseNumber = index + 1
    if (caseNumber <= 20) {
      return {
        case_id: item.case_id,
        kind: 'dialogue',
        speaker: {
          status: 'exact',
          accepted_character_ids: [caseNumber % 2 === 0 ? 'character-b' : 'character-a'],
          evidence: caseNumber % 2 === 0 ? 'coreference' : 'alias',
        },
      }
    }
    if (caseNumber === 21) {
      return {
        case_id: item.case_id,
        kind: 'dialogue',
        speaker: {
          status: 'ambiguous',
          accepted_character_ids: [],
          evidence: 'ambiguous',
        },
      }
    }
    return {
      case_id: item.case_id,
      kind: caseNumber <= 50 ? 'thought' : 'narration',
      speaker: { status: 'not_applicable', accepted_character_ids: [], evidence: 'none' },
    }
  }),
}

function buildRun(runIndex: number): EvaluationRun {
  return {
    schema_version: 'evaluation-run@1',
    run_index: runIndex,
    source_sha256: sourceHash,
    corpus_sha256: corpusHash,
    model: {
      adapter_id: 'synthetic-director',
      adapter_version: '1.0.0',
      model_id: 'synthetic-model',
      model_sha256: zeroHash,
      prompt_version: 'synthetic-prompt@1',
      prompt_sha256: sha256('synthetic-prompt'),
      output_schema_version: 'director-output@1',
      seed: 42,
      context_size: 32_768,
      parameters: { temperature: 0, top_p: 1 },
    },
    operational: {
      elapsed_ms: 3_600_000,
      peak_vram_mib: 15_872,
      peak_ram_mib: 61_440,
      crashed: false,
      out_of_memory: false,
    },
    predictions: cases.map((item, index) => {
      const caseNumber = index + 1
      const passage = passages.find((candidate) => candidate.source_ref === item.source_ref)
      if (!passage) throw new Error('Fixture source reference is missing')
      const text = Array.from(passage.source_text)
        .slice(item.source_start, item.source_end)
        .join('')
      const kind =
        caseNumber === 22
          ? 'dialogue'
          : caseNumber <= 21
            ? 'dialogue'
            : caseNumber <= 50
              ? 'thought'
              : 'narration'
      const expectedSpeaker = caseNumber % 2 === 0 ? 'character-b' : 'character-a'
      return {
        source_ref: item.source_ref,
        source_start: item.source_start,
        source_end: item.source_end,
        status: 'predicted' as const,
        text,
        kind,
        speaker:
          caseNumber === 1
            ? 'known-wrong-character'
            : caseNumber === 21
              ? 'fallback-dialogue'
              : caseNumber <= 20
                ? expectedSpeaker
                : 'narrator',
        review_required: caseNumber === 1 || caseNumber === 21,
      }
    }),
  }
}

const runs = [buildRun(1), buildRun(2), buildRun(3)]
const report = new RepresentativeCorpusScorer().score({ source, corpus, annotations, runs })
if (!report.overall_passed) throw new Error('Canonical synthetic fixture must pass')

await mkdir(fixtureRoot, { recursive: true })
const documents = [
  ['source.json', source],
  ['corpus.json', corpus],
  ['annotations.json', annotations],
  ['run-1.json', runs[0]],
  ['run-2.json', runs[1]],
  ['run-3.json', runs[2]],
  ['expected-report.json', report],
] as const
for (const [filename, document] of documents) {
  await writeFile(path.join(fixtureRoot, filename), `${JSON.stringify(document, null, 2)}\n`)
}
