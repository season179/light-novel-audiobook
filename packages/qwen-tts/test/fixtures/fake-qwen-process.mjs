import { createHash, randomUUID } from 'node:crypto'
import { appendFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

let requestText = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) requestText += chunk
const input = JSON.parse(requestText.trim())
const mode = process.env.FAKE_QWEN_MODE ?? 'normal'
if (process.env.FAKE_QWEN_LOG) {
  await appendFile(process.env.FAKE_QWEN_LOG, `${JSON.stringify(input)}\n`)
}

const emit = (type, values = {}) => {
  process.stdout.write(`${JSON.stringify({ protocolVersion: 1, type, ...values })}\n`)
}

function wav(text) {
  const words = text.trim().split(/\s+/u).length
  const sampleRate = 24_000
  const frames = Math.max(2_880, Math.round(words * sampleRate * 0.12))
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
    bytes.writeInt16LE(
      Math.round(Math.sin((frame * Math.PI * 2 * 220) / sampleRate) * 5_000),
      44 + frame * 2,
    )
  }
  return bytes
}

async function atomicWav(segment) {
  const target = join(input.outputDirectory, `${segment.segmentId}.wav`)
  const temporary = join(input.outputDirectory, `.${randomUUID()}.tmp`)
  const bytes = mode === 'invalid-wav' ? Buffer.from('not a wav') : wav(segment.text)
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
  await rename(temporary, target)
  return createHash('sha256').update(bytes).digest('hex')
}

emit('runtime-validated')
if (mode === 'malformed-event') {
  process.stdout.write('{not json}\n')
  process.exit(0)
}
emit('model-loading')
if (mode === 'process-failure-before-load') {
  process.stderr.write('synthetic model load failure\n')
  emit('fatal', { stage: 'model-load', message: 'synthetic model load failure' })
  process.exit(23)
}
if (mode === 'hang') {
  process.on('SIGTERM', async () => {
    if (process.env.FAKE_QWEN_CANCEL_LOG)
      await appendFile(process.env.FAKE_QWEN_CANCEL_LOG, 'terminated\n')
    process.exit(130)
  })
}
emit('model-loaded')

if (mode === 'hang') {
  setInterval(() => undefined, 1_000)
} else {
  const segments = input.segments
  for (const segment of segments) {
    emit('segment-started', {
      segmentId: segment.segmentId,
      sequence: mode === 'wrong-order' ? segment.sequence + 1 : segment.sequence,
    })
    const hash = await atomicWav(segment)
    emit('segment-rendered', {
      segmentId: segment.segmentId,
      sequence: segment.sequence,
      sha256: mode === 'wrong-hash' ? '0'.repeat(64) : hash,
    })
    if (mode === 'duplicate-render') {
      emit('segment-rendered', {
        segmentId: segment.segmentId,
        sequence: segment.sequence,
        sha256: hash,
      })
    }
  }
  emit('gpu-cleanup-complete')
  emit('batch-complete')
}
