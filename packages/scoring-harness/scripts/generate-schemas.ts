import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  evaluationReportSchema,
  evaluationRunSchema,
  evaluationSourceSchema,
  goldAnnotationsSchema,
  representativeCorpusSchema,
} from '../src/schemas.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const schemaRoot = path.resolve(packageRoot, '../../schemas/evaluation')
const schemas = [
  ['evaluation-source.schema.json', evaluationSourceSchema, 'evaluation-source@1'],
  ['representative-corpus.schema.json', representativeCorpusSchema, 'representative-corpus@1'],
  ['gold-annotations.schema.json', goldAnnotationsSchema, 'gold-annotations@2'],
  ['evaluation-run.schema.json', evaluationRunSchema, 'evaluation-run@2'],
  ['evaluation-report.schema.json', evaluationReportSchema, 'evaluation-report@2'],
] as const

for (const [filename, schema, id] of schemas) {
  const generated = z.toJSONSchema(schema, { target: 'draft-2020-12' })
  const jsonSchema = {
    $id: `https://local.invalid/light-novel-audiobook/evaluation/${id}`,
    ...generated,
  }
  await writeFile(path.join(schemaRoot, filename), `${JSON.stringify(jsonSchema, null, 2)}\n`)
}
