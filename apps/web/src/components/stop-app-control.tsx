import { useState } from 'react'
import type { AudiobookClient, StopPreview } from '../client/audiobook-client.js'

export interface StopAppControlProps {
  readonly client: AudiobookClient
  readonly requestStop?: (() => Promise<Response>) | undefined
}

const postStop = (): Promise<Response> =>
  fetch('/api/stop', {
    method: 'POST',
    headers: { Accept: 'application/json' },
  })

/** Global destructive control. Its confirmation always names the operation it will interrupt. */
export function StopAppControl({ client, requestStop = postStop }: StopAppControlProps) {
  const [preview, setPreview] = useState<StopPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const openConfirmation = async () => {
    setLoading(true)
    setError(null)
    const result = await client.getStopPreview()
    setLoading(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setPreview(result.value)
  }

  const stop = async () => {
    setStopping(true)
    setError(null)
    try {
      const response = await requestStop()
      const body = (await response.json()) as { stopped?: boolean; message?: string }
      if (!response.ok || body.stopped !== true) {
        throw new Error(body.message ?? 'The local server could not be stopped.')
      }
      // No query or retry runs after this acknowledgement. The page intentionally becomes a local
      // terminal state while the already-scheduled process exit closes the launcher window.
      setStopped(true)
      setPreview(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The local server could not be stopped.')
    } finally {
      setStopping(false)
    }
  }

  if (stopped) {
    return (
      <main className="server-stopped" aria-labelledby="server-stopped-heading">
        <section className="status-block" data-state="stopped" role="status" aria-live="polite">
          <p className="stage">Server stopped</p>
          <h1 id="server-stopped-heading">The local server has stopped</h1>
          <p className="latest">
            Model processes and GPU resources were released. You can close this page. Use the
            desktop shortcut to start the app again.
          </p>
        </section>
      </main>
    )
  }

  return (
    <aside className="stop-app-control" aria-label="Server controls">
      <button
        className="destructive"
        type="button"
        disabled={loading || stopping}
        onClick={() => void openConfirmation()}
      >
        {loading ? 'Checking current work…' : 'Stop app'}
      </button>
      {error !== null && preview === null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {preview !== null && (
        <div
          className="stop-confirmation"
          role="dialog"
          aria-modal="true"
          aria-labelledby="stop-heading"
        >
          <h2 id="stop-heading">Stop the local server now?</h2>
          {preview.inFlight === null ? (
            <p>No generation is in flight.</p>
          ) : (
            <p>
              <strong>{preview.inFlight.operation}</strong> is in flight. Stop now interrupts it at
              its saved checkpoint. {preview.inFlight.checkpoint}
            </p>
          )}
          <p>
            The app will stop its model workers, release the GPU through their normal cleanup path,
            and then close the launcher window.
          </p>
          <div className="actions">
            <button
              className="destructive"
              type="button"
              disabled={stopping}
              onClick={() => void stop()}
            >
              {stopping ? 'Releasing resources…' : 'Stop now and free the GPU'}
            </button>
            <button type="button" disabled={stopping} onClick={() => setPreview(null)}>
              Keep running
            </button>
          </div>
          {error !== null && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </aside>
  )
}
