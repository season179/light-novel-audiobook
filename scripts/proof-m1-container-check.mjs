/**
 * The M4B container assertions for the proof harness's real-mode output verification, extracted
 * so they can be driven directly with broken probe output (a vacuous assertion is only proven by
 * feeding it the condition it exists to catch). Every numeric field taken from ffprobe JSON is
 * validated as a finite number first: a missing or non-numeric field must fail the check, never
 * sail through a comparison that NaN always loses.
 */

export class ContainerCheckFailure extends Error {}

const fail = (message) => {
  throw new ContainerCheckFailure(message)
}

const finiteMs = (value, label) => {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    fail(`${label} is not a finite number in the ffprobe output: ${JSON.stringify(value)}`)
  }
  return Math.round(number * 1000)
}

/**
 * @param {object} probe - parsed `ffprobe -show_format -show_streams -show_chapters -of json`.
 * @param {object} expectations
 * @param {number} expectations.expectedChapters - chapter-marker count the book must carry.
 * @param {boolean} expectations.expectCover - require an attached-picture stream (the M1
 *   acceptance book has a cover; a book without one must not be failed for lacking it).
 * @param {boolean} expectations.expectCreator - require a non-empty artist tag (the acceptance
 *   book declares a creator; books without one write no artist tag by design).
 */
export const assertContainerProbe = (probe, expectations) => {
  const { expectedChapters, expectCover, expectCreator } = expectations
  if (!Number.isSafeInteger(expectedChapters) || expectedChapters <= 0) {
    fail(`expected chapter count must be positive, got ${String(expectedChapters)}`)
  }
  const streams = Array.isArray(probe?.streams) ? probe.streams : []
  const audio = streams.find((stream) => stream.codec_type === 'audio')
  if (audio === undefined) fail('the M4B has no audio stream')
  if (audio.codec_name !== 'aac') {
    fail(`M4B audio codec is ${audio.codec_name}, not aac`)
  }

  const chapters = Array.isArray(probe?.chapters) ? probe.chapters : []
  const markers = chapters.map((chapter, index) => ({
    startMs: finiteMs(chapter?.start_time, `chapter marker ${index + 1} start_time`),
    endMs: finiteMs(chapter?.end_time, `chapter marker ${index + 1} end_time`),
  }))
  if (markers.length !== expectedChapters) {
    fail(`the M4B carries ${markers.length} chapter marker(s), expected ${expectedChapters}`)
  }
  const durationMs = finiteMs(probe?.format?.duration, 'container duration')
  let cursor = 0
  for (const [index, marker] of markers.entries()) {
    if (marker.startMs !== cursor || marker.endMs <= marker.startMs) {
      fail(
        `chapter marker ${index + 1} spans ${marker.startMs}..${marker.endMs}ms, ` +
          `not a contiguous positive span beginning at ${cursor}ms`,
      )
    }
    cursor = marker.endMs
  }
  if (Math.abs(durationMs - cursor) > 2_000) {
    fail(`chapter markers end at ${cursor}ms but the stream is ${durationMs}ms`)
  }

  if (expectCover) {
    const cover = streams.find(
      (stream) => stream.codec_type === 'video' && Number(stream.disposition?.attached_pic) === 1,
    )
    if (cover === undefined) {
      fail(
        'the M4B has no attached-picture stream: the cover art the book declares was not embedded',
      )
    }
  }

  const tags = probe?.format?.tags ?? {}
  if (typeof tags.title !== 'string' || tags.title.trim().length === 0) {
    fail('the M4B carries no title metadata')
  }
  if (expectCreator && (typeof tags.artist !== 'string' || tags.artist.trim().length === 0)) {
    fail('the M4B carries no creator (artist) metadata')
  }

  return {
    formatName: probe?.format?.format_name,
    codec: audio.codec_name,
    durationMs,
    chapterMarkers: markers.length,
    markerSpansOrdered: true,
    ...(expectCover ? { coverEmbedded: true } : {}),
    titlePresent: true,
    ...(expectCreator ? { creatorPresent: true } : {}),
  }
}
