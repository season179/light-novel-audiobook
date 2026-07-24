import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">Local audiobook studio</p>
        <h1>Light Novel Audiobook</h1>
        <p>
          Import an EPUB, review the directed script and synthetic cast, then generate a versioned
          audiobook on this machine.
        </p>
      </header>

      <section className="panel" aria-labelledby="status-heading">
        <div>
          <p className="eyebrow">Project status</p>
          <h2 id="status-heading">Foundation ready</h2>
          <p>The import and generation workflow will be added in the next implementation stage.</p>
        </div>
        <span className="status">Local only</span>
      </section>
    </main>
  )
}
