import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { WavRequirements } from '../src/config.js'
import { loadProductionConfig } from '../src/config.js'
import { validateCanonicalWavBytes } from '../src/wav.js'

const execute = promisify(execFile)
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, '../..')
const PRODUCTION_CONFIG = join(REPOSITORY_ROOT, 'config/qwen3-tts-production.json')
const PYTHON_WORKER = join(PACKAGE_ROOT, 'python/qwen_batch_worker.py')
const ONE_WORD = 'Steady.'

let requirements: WavRequirements
let temporaryRoot: string

function words(count: number): string {
  return Array.from({ length: count }, () => 'word').join(' ')
}

function canonicalActiveWav(
  durationSeconds: number,
  mode: 'active' | 'silent' | 'clipped' = 'active',
): Buffer {
  const sampleRate = 24_000
  const frames = Math.round(durationSeconds * sampleRate)
  const bytes = Buffer.alloc(44 + frames * 2)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVE', 8)
  bytes.write('fmt ', 12)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(sampleRate, 24)
  bytes.writeUInt32LE(sampleRate * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(frames * 2, 40)
  for (let frame = 0; frame < frames; frame += 1) {
    const sample =
      mode === 'silent'
        ? 0
        : mode === 'clipped'
          ? 32_760
          : Math.round(3_000 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate))
    bytes.writeInt16LE(sample, 44 + frame * 2)
  }
  return bytes
}

function validate(durationSeconds: number, text: string, segmentId: string): void {
  validateCanonicalWavBytes(canonicalActiveWav(durationSeconds), requirements, text, segmentId)
}

beforeAll(async () => {
  requirements = (await loadProductionConfig(PRODUCTION_CONFIG)).value.wav
  temporaryRoot = await mkdtemp(join(tmpdir(), 'qwen-wav-health-gate-'))
})

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true })
})

describe('calibrated affine WAV duration gate', () => {
  it('pins the measured short-utterance floor and upper-envelope allowance', () => {
    expect(requirements.minimumUtteranceDurationSeconds).toBe(0.32)
    expect(requirements.fixedUtteranceOverheadSeconds).toBe(1)
  })

  it('accepts the measured healthy 0.40-second lower-envelope one-word render', () => {
    expect(() => validate(0.4, ONE_WORD, 'healthy-minimum-short')).not.toThrow()
  })

  it('rejects a canonical, active, unclipped truncated one-word render', () => {
    expect(() => validate(0.16, ONE_WORD, 'truncated-short')).toThrow(
      'duration is outside configured text-relative bounds',
    )
  })

  it('accepts the measured healthy 2.64-second one-word render', () => {
    expect(() => validate(2.64, ONE_WORD, 'healthy-short')).not.toThrow()
  })

  it.each([4, 6, 12])(
    'rejects an active, unclipped one-word runaway at %d seconds',
    (durationSeconds) => {
      expect(() => validate(durationSeconds, ONE_WORD, `runaway-${durationSeconds}`)).toThrow(
        'duration is outside configured text-relative bounds',
      )
    },
  )

  it('retains the per-word lower bound for longer segments', () => {
    expect(() => validate(4, words(50), 'lower-rate-edge')).not.toThrow()
    expect(() => validate(3.96, words(50), 'lower-rate-rejection')).toThrow(
      'duration is outside configured text-relative bounds',
    )
  })

  it('retains the independent absolute duration cap', () => {
    expect(() => validate(31, words(20), 'absolute-runaway')).toThrow(
      'duration is outside configured text-relative bounds',
    )
  })

  it('still rejects clipped and inactive audio', () => {
    expect(() =>
      validateCanonicalWavBytes(
        canonicalActiveWav(1, 'clipped'),
        requirements,
        ONE_WORD,
        'clipped',
      ),
    ).toThrow('audio is clipped')
    expect(() =>
      validateCanonicalWavBytes(canonicalActiveWav(1, 'silent'), requirements, ONE_WORD, 'silent'),
    ).toThrow('audio is silent or mostly inactive')
  })

  it('keeps the Python production worker in step for healthy and runaway short renders', async () => {
    const cases = [
      { id: 'healthy-minimum-short', duration: 0.4, accepted: true },
      { id: 'truncated-short', duration: 0.16, accepted: false },
      { id: 'healthy-short', duration: 2.64, accepted: true },
      { id: 'runaway-4', duration: 4, accepted: false },
      { id: 'runaway-6', duration: 6, accepted: false },
      { id: 'runaway-12', duration: 12, accepted: false },
    ]
    const records = []
    for (const item of cases) {
      const path = join(temporaryRoot, `${item.id}.wav`)
      await writeFile(path, canonicalActiveWav(item.duration))
      records.push({ ...item, path })
    }
    const program = `
import importlib.util, json, pathlib, sys
worker_path, config_path, records_json = sys.argv[1:]
spec = importlib.util.spec_from_file_location("qwen_worker_health_test", worker_path)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
requirements = json.loads(pathlib.Path(config_path).read_text(encoding="utf-8"))["wav"]
results = []
for record in json.loads(records_json):
    try:
        worker.validate_wav(pathlib.Path(record["path"]).read_bytes(), requirements, "Steady.")
        accepted = True
    except ValueError:
        accepted = False
    results.append({"id": record["id"], "accepted": accepted})
print(json.dumps(results))
`
    const { stdout } = await execute('python3', [
      '-c',
      program,
      PYTHON_WORKER,
      PRODUCTION_CONFIG,
      JSON.stringify(records),
    ])
    expect(JSON.parse(stdout) as Array<{ id: string; accepted: boolean }>).toEqual(
      cases.map(({ id, accepted }) => ({ id, accepted })),
    )
  })
})
