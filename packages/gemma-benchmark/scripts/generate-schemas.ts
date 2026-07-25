import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { benchmarkContextSchema } from '../src/schemas.js'

const output = resolve(
  import.meta.dirname,
  '../../../schemas/evaluation/benchmark-context.schema.json',
)
const schema = z.toJSONSchema(benchmarkContextSchema, {
  target: 'draft-2020-12',
  io: 'input',
}) as Record<string, unknown>
schema.$id = 'https://local.invalid/light-novel-audiobook/evaluation/benchmark-context@1'
await writeFile(output, `${JSON.stringify(schema, null, 2)}\n`)
