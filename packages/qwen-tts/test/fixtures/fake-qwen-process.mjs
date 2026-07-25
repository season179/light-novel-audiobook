import { createHash, randomUUID } from 'node:crypto'
import { appendFile, link, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const mode = process.env.FAKE_QWEN_MODE ?? 'normal'
let terminating = false
process.on('SIGTERM', async () => {
  if (terminating) return
  terminating = true
  if (process.env.FAKE_QWEN_CANCEL_LOG) {
    await appendFile(process.env.FAKE_QWEN_CANCEL_LOG, `term-start:${Date.now()}\n`)
  }
  if (mode === 'slow-terminate') await new Promise((resolve) => setTimeout(resolve, 120))
  if (process.env.FAKE_QWEN_CANCEL_LOG) {
    await appendFile(process.env.FAKE_QWEN_CANCEL_LOG, `term-exit:${Date.now()}\n`)
  }
  process.exit(130)
})

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })[
  Symbol.asyncIterator
]()
const nextMessage = async () => {
  const line = await lines.next()
  if (line.done) throw new Error('protocol input closed')
  return JSON.parse(line.value)
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

async function atomicWav(begin, segment) {
  const target = join(begin.outputDirectory, `${segment.segmentId}.wav`)
  const temporary = join(begin.outputDirectory, `.${randomUUID()}.tmp`)
  const bytes = mode === 'invalid-wav' ? Buffer.from('not a wav') : wav(segment.text)
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
  if (begin.allowOverwriteExisting) await rename(temporary, target)
  else {
    await link(temporary, target)
    await unlink(temporary)
  }
  return createHash('sha256').update(bytes).digest('hex')
}

try {
  const begin = await nextMessage()
  const invocation = {
    ...begin,
    segments: [],
    ambientPython: {
      PYTHONHOME: process.env.PYTHONHOME ?? null,
      PYTHONPATH: process.env.PYTHONPATH ?? null,
      PYTHONSTARTUP: process.env.PYTHONSTARTUP ?? null,
    },
  }
  emit('runtime-validated')
  if (mode === 'malformed-event') {
    process.stdout.write('{not json}\n')
    setInterval(() => undefined, 1_000)
  } else {
    emit('model-loading')
    if (mode === 'process-failure-before-load') {
      process.stderr.write('synthetic model load failure\n')
      emit('fatal', { stage: 'model-load', message: 'synthetic model load failure' })
      process.exit(23)
    }
    emit('model-loaded')
    if (mode === 'hang' || mode === 'slow-terminate') {
      setInterval(() => undefined, 1_000)
    } else {
      while (true) {
        const message = await nextMessage()
        if (message.command === 'end-batch') break
        const segment = message.segment
        invocation.segments.push(segment)
        emit('segment-started', {
          segmentId: segment.segmentId,
          sequence: mode === 'wrong-order' ? segment.sequence + 1 : segment.sequence,
        })
        const hash = await atomicWav(begin, segment)
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
      if (process.env.FAKE_QWEN_LOG) {
        await appendFile(process.env.FAKE_QWEN_LOG, `${JSON.stringify(invocation)}\n`)
      }
      emit('gpu-cleanup-complete')
      emit('batch-complete')
    }
  }
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`)
  emit('fatal', { stage: 'fake-worker', message: String(error.message ?? error) })
  process.exitCode = 1
}
