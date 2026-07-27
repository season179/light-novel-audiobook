import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useId, useState } from 'react'
import type {
  AudiobookClient,
  EpubUploadView,
  SliceLimits,
  StartGenerationCommand,
} from '../client/audiobook-client.js'
import type { WebApiFailure } from '../server/errors.js'

export interface EpubUploadPanelProps {
  readonly client: AudiobookClient
  /** Called once generation has been accepted, so the page can show the job. */
  readonly onStarted: (jobId: string) => void
}

const formatBytes = (byteLength: number): string => {
  if (byteLength < 1024) return `${byteLength} B`
  if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(1)} KB`
  return `${(byteLength / (1024 * 1024)).toFixed(1)} MB`
}

/** Empty means unbounded. Anything entered must be a positive whole number. */
const parseBound = (raw: string): number | 'invalid' | undefined => {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value >= 1 ? value : 'invalid'
}

/**
 * EPUB upload and the single generate action. The component decides nothing about books, voices, or
 * models: it posts the file, shows what the API said, and asks the API to start generation.
 */
export function EpubUploadPanel({ client, onStarted }: EpubUploadPanelProps) {
  const fileInputId = useId()
  const hintId = useId()
  const errorId = useId()
  const queryClient = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [upload, setUpload] = useState<EpubUploadView | null>(null)
  const [failure, setFailure] = useState<WebApiFailure | null>(null)
  const [firstChapter, setFirstChapter] = useState('')
  const [maxChapters, setMaxChapters] = useState('')
  const [maxPassages, setMaxPassages] = useState('')

  const recentUploads = useQuery({
    queryKey: ['epub-uploads'],
    // A failure here only costs a convenience list, so it degrades to empty rather than blocking
    // the upload form. Real failures the user must act on come back through the mutations.
    queryFn: async () => {
      const result = await client.listUploads()
      return result.ok ? result.value : []
    },
  })

  const uploadMutation = useMutation({
    mutationFn: async (selected: File) => client.uploadEpub({ file: selected }),
    onSuccess: async (result) => {
      if (!result.ok) {
        setFailure(result.error)
        setUpload(null)
        return
      }
      setFailure(null)
      setUpload(result.value)
      await queryClient.invalidateQueries({ queryKey: ['epub-uploads'] })
    },
  })

  const startMutation = useMutation({
    mutationFn: async (command: StartGenerationCommand) => client.startGeneration(command),
    onSuccess: (result) => {
      if (!result.ok) {
        setFailure(result.error)
        return
      }
      setFailure(null)
      onStarted(result.value.jobId)
    },
  })

  const handleUpload = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (file === null) {
      setFailure({ code: 'invalid_upload', message: 'Choose an EPUB file to upload.' })
      return
    }
    uploadMutation.mutate(file)
  }

  const start = (uploadId: string) => {
    startMutation.mutate({ uploadId, recoverAbandoned: false, slice: {} })
  }

  /**
   * Starts a bounded render from the slice fields. An all-empty form is the unqualified start —
   * exactly the same job as the whole-book button — and an unparseable field is rejected here,
   * before any job exists, rather than being dropped into a silent whole-book render.
   */
  const startSlice = (uploadId: string) => {
    const bounds = [firstChapter, maxChapters, maxPassages].map(parseBound)
    if (bounds.some((bound) => bound === 'invalid')) {
      setFailure({
        code: 'invalid_request',
        message: 'Slice bounds must be positive whole numbers, or left empty.',
      })
      return
    }
    const [first, chapters, passages] = bounds as (number | undefined)[]
    const slice: SliceLimits = {
      ...(first === undefined ? {} : { firstChapter: first }),
      ...(chapters === undefined ? {} : { maxChapters: chapters }),
      ...(passages === undefined ? {} : { maxPassagesPerChapter: passages }),
    }
    startMutation.mutate({ uploadId, recoverAbandoned: false, slice })
  }

  return (
    <section className="panel stack" aria-labelledby="upload-heading">
      <h2 id="upload-heading">Import an EPUB</h2>

      <form className="stack" onSubmit={handleUpload}>
        <div className="field">
          <label htmlFor={fileInputId}>EPUB file</label>
          <input
            id={fileInputId}
            type="file"
            name="file"
            accept=".epub,application/epub+zip"
            aria-describedby={failure === null ? hintId : `${hintId} ${errorId}`}
            onChange={(event) => {
              setFile(event.target.files?.item(0) ?? null)
              setFailure(null)
            }}
          />
          <p id={hintId} className="hint">
            The file is stored in your local workspace outside this repository. Nothing is uploaded
            off this machine.
          </p>
        </div>

        {failure !== null && (
          <p id={errorId} className="error" role="alert">
            {failure.message}
          </p>
        )}

        <div className="actions">
          <button type="submit" disabled={uploadMutation.isPending}>
            {uploadMutation.isPending ? 'Uploading…' : 'Upload EPUB'}
          </button>
        </div>
      </form>

      {upload !== null && (
        <div className="stack bordered">
          <h3>Ready to generate</h3>
          <dl className="summary">
            <dt>File</dt>
            <dd>{upload.fileName}</dd>
            <dt>Size</dt>
            <dd>{formatBytes(upload.byteLength)}</dd>
            <dt>Content hash</dt>
            <dd>
              <code>{upload.sha256.slice(0, 16)}…</code>
            </dd>
          </dl>
          <div className="actions">
            <button
              type="button"
              onClick={() => start(upload.uploadId)}
              disabled={startMutation.isPending}
            >
              {startMutation.isPending ? 'Starting…' : 'Generate audiobook'}
            </button>
          </div>

          <fieldset className="stack" disabled={startMutation.isPending}>
            <legend>Generate only part of the book (optional)</legend>
            <div className="field">
              <label htmlFor={`${fileInputId}-first-chapter`}>Start at chapter</label>
              <input
                id={`${fileInputId}-first-chapter`}
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={firstChapter}
                onChange={(event) => setFirstChapter(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor={`${fileInputId}-max-chapters`}>Number of chapters</label>
              <input
                id={`${fileInputId}-max-chapters`}
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={maxChapters}
                onChange={(event) => setMaxChapters(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor={`${fileInputId}-max-passages`}>Passages per chapter</label>
              <input
                id={`${fileInputId}-max-passages`}
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={maxPassages}
                onChange={(event) => setMaxPassages(event.target.value)}
              />
            </div>
            <p className="hint">
              A bounded start is a separate job with its own progress and audio. Leave every field
              empty to match “Generate audiobook”.
            </p>
            <div className="actions">
              <button type="button" onClick={() => startSlice(upload.uploadId)}>
                {startMutation.isPending ? 'Starting…' : 'Generate this slice'}
              </button>
            </div>
          </fieldset>
        </div>
      )}

      {recentUploads.data !== undefined && recentUploads.data.length > 0 && (
        <div className="stack">
          <h3 id="recent-heading">Uploaded books in this workspace</h3>
          <ul className="listing" aria-labelledby="recent-heading">
            {recentUploads.data.map((entry) => (
              <li key={entry.uploadId}>
                <span>{entry.fileName}</span>
                <button
                  type="button"
                  aria-label={`Generate or resume the audiobook for ${entry.fileName}`}
                  onClick={() => start(entry.uploadId)}
                >
                  Generate or resume
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
