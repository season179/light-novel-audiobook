import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  evaluationReportSchema,
  evaluationRunSchema,
  evaluationSourceSchema,
  goldAnnotationsSchema,
  representativeCorpusSchema,
} from '../src/schemas.js'

const schemaRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../schemas/evaluation',
)
const schemas = [
  ['evaluation-source.schema.json', evaluationSourceSchema, 'evaluation-source@1'],
  ['representative-corpus.schema.json', representativeCorpusSchema, 'representative-corpus@1'],
  ['gold-annotations.schema.json', goldAnnotationsSchema, 'gold-annotations@1'],
  ['evaluation-run.schema.json', evaluationRunSchema, 'evaluation-run@1'],
  ['evaluation-report.schema.json', evaluationReportSchema, 'evaluation-report@1'],
] as const

describe('published evaluation schemas', () => {
  it.each(schemas)('%s matches its runtime validator', async (filename, schema, id) => {
    const committed = JSON.parse(await readFile(path.join(schemaRoot, filename), 'utf8')) as Record<
      string,
      unknown
    >
    const expected = {
      $id: `https://local.invalid/light-novel-audiobook/evaluation/${id}`,
      ...z.toJSONSchema(schema, { target: 'draft-2020-12' }),
    }
    expect(committed).toEqual(expected)
  })
})
