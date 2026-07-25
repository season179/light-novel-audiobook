/**
 * Minimal 16-bit mono PCM WAV writer for the FAKE speech engine and assembler. The clips are tiny,
 * deterministic, and audible enough to prove the browser can play what the flow produced.
 */
const SAMPLE_RATE = 24_000
const BITS_PER_SAMPLE = 16
const HEADER_BYTES = 44

export const WAV_HEADER_BYTES = HEADER_BYTES

const writeHeader = (dataByteLength: number): Buffer => {
  const header = Buffer.alloc(HEADER_BYTES)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + dataByteLength, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE((SAMPLE_RATE * BITS_PER_SAMPLE) / 8, 28)
  header.writeUInt16LE(BITS_PER_SAMPLE / 8, 32)
  header.writeUInt16LE(BITS_PER_SAMPLE, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(dataByteLength, 40)
  return header
}

/** Deterministic quiet tone whose pitch and length come from the segment identity and text. */
export const createPlaceholderWav = (seedText: string, characterCount: number): Buffer => {
  let seed = 0
  for (const character of seedText) {
    seed = (seed * 31 + (character.codePointAt(0) ?? 0)) % 65_536
  }
  const sampleCount = Math.min(9_600, 480 + characterCount * 48)
  const frequency = 180 + (seed % 120)
  const samples = Buffer.alloc(sampleCount * 2)
  for (let index = 0; index < sampleCount; index += 1) {
    const fade = Math.min(1, Math.min(index, sampleCount - index) / 240)
    const value = Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE) * 2_600 * fade
    samples.writeInt16LE(Math.round(value), index * 2)
  }
  return Buffer.concat([writeHeader(samples.byteLength), samples])
}

/** Joins WAV clips into one WAV by re-heading the concatenated PCM payloads. */
export const concatenateWavs = (clips: readonly Buffer[]): Buffer => {
  const payloads = clips
    .filter((clip) => clip.byteLength > HEADER_BYTES)
    .map((clip) => clip.subarray(HEADER_BYTES))
  const data = Buffer.concat(payloads.length === 0 ? [Buffer.alloc(2)] : payloads)
  return Buffer.concat([writeHeader(data.byteLength), data])
}
