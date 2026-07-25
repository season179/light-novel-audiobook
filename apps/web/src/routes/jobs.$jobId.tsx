import { createFileRoute, Link } from '@tanstack/react-router'
import { serverFnAudiobookClient } from '../client/server-fn-audiobook-client.js'
import { JobProgressPanel } from '../components/job-progress-panel.js'

export const Route = createFileRoute('/jobs/$jobId')({
  component: JobRoute,
})

function JobRoute() {
  const { jobId } = Route.useParams()

  return (
    <main className="shell stack">
      <header className="hero">
        <p className="eyebrow">Generation</p>
        <h1>Audiobook progress</h1>
        <p>
          This page reads job state from the local server, so you can reload it or come back later
          without losing progress.
        </p>
        <p>
          <Link to="/">Back to import</Link>
        </p>
      </header>

      <JobProgressPanel client={serverFnAudiobookClient} jobId={jobId} />
    </main>
  )
}
