import type { AudiobookOutputView, ChapterAudioView } from '../server/job-state-view.js'

export interface ChapterAudioListProps {
  readonly output: AudiobookOutputView
}

const chapterName = (chapter: ChapterAudioView): string =>
  chapter.title === null ? chapter.chapterLabel : `${chapter.chapterLabel} — ${chapter.title}`

/** Per-chapter playback plus the numbered M4B download for a completed audiobook. */
export function ChapterAudioList({ output }: ChapterAudioListProps) {
  return (
    <section className="stack bordered" aria-labelledby="result-heading">
      <h3 id="result-heading">Audiobook {output.versionLabel}</h3>
      <p>
        <a className="download" href={output.downloadUrl} download={output.m4bFileName}>
          Download the M4B ({output.m4bFileName})
        </a>
      </p>
      <ol className="chapters">
        {output.chapters.map((chapter) => (
          <li key={chapter.chapterId} className="stack">
            <h4>{chapterName(chapter)}</h4>
            {/* biome-ignore lint/a11y/useMediaCaption: generated speech has no separate caption track in M1. */}
            <audio
              controls
              preload="none"
              src={chapter.audioUrl}
              aria-label={`Play ${chapterName(chapter)}`}
            />
            <a href={chapter.audioUrl} download={chapter.fileName}>
              Download {chapter.fileName}
            </a>
          </li>
        ))}
      </ol>
    </section>
  )
}
