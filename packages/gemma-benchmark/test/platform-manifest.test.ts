import { describe, expect, it } from 'vitest'
import { classifyExternalBrainFilesystem } from '../src/path-safety.js'
import { type HostManifest, hostManifestSchema, requireCudaCompiler } from '../src/runtime.js'

const hashes = {
  llamaCommit: '1'.repeat(40),
  binarySha256: '2'.repeat(64),
  modelRevision: '3'.repeat(40),
  modelSha256: '4'.repeat(64),
  modelSizeBytes: 1,
  cmakeConfigurationSha256: '5'.repeat(64),
  cleanSourceCheckout: true,
  cleanRebuild: true,
  textModelOnly: true,
} as const

describe('platform-discriminated host manifests', () => {
  it('keeps the historical schema-v1 CUDA shape readable without rewriting it', () => {
    const historical = {
      schemaVersion: 1,
      ...hashes,
      cudaCompiler: 'Build cuda_13.0',
    } as const

    expect(hostManifestSchema.parse(historical)).toEqual(historical)
    expect(requireCudaCompiler(hostManifestSchema.parse(historical))).toBe('Build cuda_13.0')
  })

  it('requires CUDA compiler identity in the schema-v2 CUDA build record', () => {
    const cuda = {
      schemaVersion: 2,
      ...hashes,
      buildRecord: { backend: 'cuda', cudaCompiler: 'Build cuda_13.0' },
    } as const

    expect(hostManifestSchema.parse(cuda)).toEqual(cuda)
    expect(requireCudaCompiler(hostManifestSchema.parse(cuda))).toBe('Build cuda_13.0')
    expect(() =>
      hostManifestSchema.parse({
        ...cuda,
        buildRecord: { backend: 'cuda' },
      }),
    ).toThrow()
  })

  it('accepts a Metal build without CUDA fields and rejects CUDA-shaped Metal records', () => {
    const metal = {
      schemaVersion: 2,
      ...hashes,
      buildRecord: {
        backend: 'metal',
        target: 'darwin-arm64',
        compiler: 'Apple clang 17.0.0',
      },
    } as const

    const parsed = hostManifestSchema.parse(metal)
    expect(parsed).toEqual(metal)
    expect(() => requireCudaCompiler(parsed)).toThrow('not a CUDA build')
    expect(() =>
      hostManifestSchema.parse({
        ...metal,
        buildRecord: { ...metal.buildRecord, cudaCompiler: 'fabricated CUDA' },
      }),
    ).toThrow()
    expect(() => hostManifestSchema.parse({ ...metal, cudaCompiler: 'fabricated CUDA' })).toThrow()
  })

  it('keeps HostManifest usable as the v1-or-v2 reader type', () => {
    const values: HostManifest[] = [
      hostManifestSchema.parse({ schemaVersion: 1, ...hashes, cudaCompiler: 'CUDA' }),
      hostManifestSchema.parse({
        schemaVersion: 2,
        ...hashes,
        buildRecord: {
          backend: 'metal',
          target: 'darwin-arm64',
          compiler: 'Apple clang',
        },
      }),
    ]
    expect(values.map((value) => value.schemaVersion)).toEqual([1, 2])
  })
})

describe('platform-correct external filesystem classification', () => {
  it('accepts ext4 only for Linux and APFS only for Darwin', () => {
    expect(classifyExternalBrainFilesystem('linux', 0xef53)).toBe('ext4')
    expect(classifyExternalBrainFilesystem('darwin', 0x1a)).toBe('apfs')
    expect(() => classifyExternalBrainFilesystem('linux', 0x1a)).toThrow('must use ext4')
    expect(() => classifyExternalBrainFilesystem('darwin', 0xef53)).toThrow('must use APFS')
  })

  it('does not silently classify unsupported platforms', () => {
    expect(() => classifyExternalBrainFilesystem('win32', 0xef53)).toThrow(
      'Unsupported external brain platform',
    )
  })
})
