import { createGemmaDirectorIdentity } from '@light-novel-audiobook/gemma-director'
import { describe, expect, it } from 'vitest'
import { createDirectorContentIdentity } from '../src/server/director-content-identity.js'

// Issue #54 item 2. Pre-fix evidence: the adapter's own identity moved when only the environment
// did — createGemmaDirectorIdentity(A) !== createGemmaDirectorIdentity(B) for A and B differing
// solely in baseUrl and gpuLeaseLockFilePath — and GenerateAudiobook folds that hash into the
// command identity, so the moved environment wedged resumable jobs.

describe('createDirectorContentIdentity', () => {
  it('ignores the brain address and GPU lease lock path', () => {
    const onGpuBox = createDirectorContentIdentity({
      baseUrl: 'http://gpu-box:8080/v1',
      confidenceThreshold: 0.7,
      gpuLeaseLockFilePath: '/run/lease/gpu-a.lock',
    })
    const afterMoves = createDirectorContentIdentity({
      baseUrl: 'http://localhost:9999/v1',
      confidenceThreshold: 0.7,
      gpuLeaseLockFilePath: '/var/lib/lna/leases/gpu-b.lock',
    })
    expect(afterMoves).toBe(onGpuBox)
    expect(onGpuBox).toMatch(/^[a-f\d]{64}$/)
  })

  it('still binds direction content settings, including threshold and chunking', () => {
    const base = {
      baseUrl: 'http://gpu-box:8080/v1',
      confidenceThreshold: 0.7,
      gpuLeaseLockFilePath: '/run/lease/gpu-a.lock',
    }
    expect(createDirectorContentIdentity({ ...base, confidenceThreshold: 0.8 })).not.toBe(
      createDirectorContentIdentity(base),
    )
    expect(
      createDirectorContentIdentity({ ...base, chunking: { windowPassageBudget: 3 } }),
    ).not.toBe(createDirectorContentIdentity(base))
  })

  it('documents the pre-fix wedge it replaces: the raw adapter identity follows the environment', () => {
    const onGpuBox = createGemmaDirectorIdentity({
      baseUrl: 'http://gpu-box:8080/v1',
      confidenceThreshold: 0.7,
      gpuLeaseLockFilePath: '/run/lease/gpu-a.lock',
    })
    const afterMoves = createGemmaDirectorIdentity({
      baseUrl: 'http://localhost:9999/v1',
      confidenceThreshold: 0.7,
      gpuLeaseLockFilePath: '/var/lib/lna/leases/gpu-b.lock',
    })
    // This is exactly why the composition seam must not feed the raw identity to the command.
    expect(afterMoves).not.toBe(onGpuBox)
  })
})
