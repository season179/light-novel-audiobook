import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { serverFnAudiobookClient } from '../client/server-fn-audiobook-client.js'
import { EpubUploadPanel } from '../components/epub-upload-panel.js'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  const navigate = useNavigate()

  return (
    <main className="shell stack">
      <header className="hero">
        <p className="eyebrow">Local audiobook studio</p>
        <h1>Light Novel Audiobook</h1>
        <p>
          Import an EPUB, generate it into a numbered audiobook on this machine, then play the
          chapters or download the M4B. Nothing leaves this computer.
        </p>
      </header>

      <EpubUploadPanel
        client={serverFnAudiobookClient}
        onStarted={(jobId) => {
          void navigate({ to: '/jobs/$jobId', params: { jobId } })
        }}
      />
    </main>
  )
}
