import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APPROVED_SPEAKERS,
  loadProductionConfig,
  SELECTED_VOICE_PROFILE_IDS,
  VOICE_PROFILE_IDS,
} from '../src/index.js'

const config = await loadProductionConfig(
  join(resolve(import.meta.dirname, '../../..'), 'config/qwen3-tts-production.json'),
)

describe('issue #105 MPS MVP human voice policy', () => {
  it('retains all technically auditioned profiles but selects only seven approved speakers', () => {
    expect([...config.profiles.keys()]).toEqual(VOICE_PROFILE_IDS)
    expect([...config.selectedProfiles.keys()]).toEqual(SELECTED_VOICE_PROFILE_IDS)
    expect([...config.selectedProfiles.values()].map((profile) => profile.speaker).sort()).toEqual([
      'Aiden',
      'Ryan',
      'Ryan',
      'dylan',
      'ono_anna',
      'sohee',
      'uncle_fu',
      'vivian',
    ])
    expect([...APPROVED_SPEAKERS].sort()).toEqual([
      'Aiden',
      'Ryan',
      'dylan',
      'ono_anna',
      'sohee',
      'uncle_fu',
      'vivian',
    ])
  })

  it('binds Eric as conditional and Serena as excluded to their reviewed MPS hashes', () => {
    const decisions = new Map(
      config.value.mpsMvpVoicePolicy.reviewedSpeakers.map((decision) => [
        decision.speaker,
        decision,
      ]),
    )
    expect(decisions.get('eric')).toEqual({
      speaker: 'eric',
      status: 'conditional',
      reviewedOutputSha256: '37d32b0877a8f92efc15a380002991fa251da07d3fd3774bd6af8135ec31951d',
      reason: 'unwanted sound-effect-like intro; requires a clean separately reviewed render',
    })
    expect(decisions.get('serena')).toEqual({
      speaker: 'serena',
      status: 'excluded',
      reviewedOutputSha256: 'c144262db44a59680016c91803b76689d899821e30b960d5d76e036db824c7f0',
      reason: 'robotic in the reviewed MPS profile',
    })
    expect([...config.selectedProfiles.keys()]).not.toContain('eric-neutral-read')
    expect([...config.selectedProfiles.keys()]).not.toContain('serena-neutral-read')
  })
})
