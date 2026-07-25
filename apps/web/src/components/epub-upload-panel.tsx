import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useId, useState } from 'react'
import type { AudiobookClient, EpubUploadView } from '../client/audiobook-client.js'
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
  const [recoverable, setRecoverable] = useState<string | null>(null)

  const recentUploads = useQuery({
    queryKey: ['epub-uploads'],
    queryFn: () => client.listUploads(),
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
      setRecoverable(null)
      setUpload(result.upload)
      await queryClient.invalidateQueries({ queryKey: ['epub-uploads'] })
    },
  })

  const startMutation = useMutation({
    mutationFn: async (input: { uploadId: string; recoverAbandoned: boolean }) =>
      client.startGeneration(input),
    onSuccess: (result, input) => {
      if (!result.ok) {
        setFailure(result.error)
        setRecoverable(result.error.code === 'generation_rejected' ? input.uploadId : null)
        return
      }
      setFailure(null)
      setRecoverable(null)
      onStarted(result.jobId)
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

  const start = (uploadId: string, recoverAbandoned = false) => {
    startMutation.mutate({ uploadId, recoverAbandoned })
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
          {recoverable !== null && (
            <button type="button" onClick={() => start(recoverable, true)}>
              Recover and continue
            </button>
          )}
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
