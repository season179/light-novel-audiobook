import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const packageUrl = new URL('../', import.meta.url)

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(relativePath, packageUrl), 'utf8')) as Record<
    string,
    unknown
  >
}

describe('committed spike provenance and host evidence', () => {
  it('pins public artifacts and records a scoped go decision', async () => {
    const provenance = await readJson('provenance.json')
    expect(provenance).toMatchObject({
      schemaVersion: 1,
      decision: 'go',
      tanstackAi: {
        core: { version: '0.42.0' },
        openAiAdapter: { version: '0.17.1' },
      },
      llamaCpp: {
        project: 'ggml-org/llama.cpp',
        commit: '555881ebc8b0fc0402b30e09258a32a7bfd13c52',
      },
      model: {
        revision: '09816acd5d99df7be770d85ea30822623dab342c',
        sha256: '2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d',
        license: 'Apache-2.0',
        storedOutsideGit: true,
      },
    })
  })

  it('keeps real evidence sanitized and proves loopback, schema, cancellation, and cleanup', async () => {
    const evidence = await readJson('evidence/real-host-run.json')
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      decision: 'go',
      endpoint: {
        host: '127.0.0.1',
        productionDefault: 'http://127.0.0.1:8080/v1',
      },
      listener: { loopbackOnly: true },
      structuredOutput: { jsonSchemaReachedServer: true, schemaValid: true },
      cancellation: {
        requestReachedServer: true,
        serverSlotReleased: true,
        clientSlotReleased: true,
      },
      cleanup: { portReleased: true },
    })
    const serialized = JSON.stringify(evidence)
    expect(serialized).not.toMatch(/\/home\/|\/mnt\/|[A-Z]:\\/)
    expect(serialized).not.toMatch(/"(?:pid|rawPrompt|rawResponse|logPath)"/i)
  })
})
