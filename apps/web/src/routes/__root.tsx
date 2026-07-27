import { type QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'
import appCss from '../styles/app.css?url'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Light Novel Audiobook' },
      {
        name: 'description',
        content: 'Local EPUB-to-audiobook review and generation workspace',
      },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
  notFoundComponent: NotFound,
})

function RootComponent() {
  const { queryClient } = Route.useRouteContext()

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
    </QueryClientProvider>
  )
}

/**
 * Reached only by a URL that matches no route at all (a typo or a stale link). A bookmarked job
 * page whose job is gone never lands here: `/jobs/$jobId` still matches, and JobProgressPanel
 * renders its own missing-job message inside the normal layout.
 */
function NotFound() {
  return (
    <main className="shell stack">
      <header className="hero">
        <p className="eyebrow">Local audiobook studio</p>
        <h1>Page not found</h1>
        <p>
          No page exists at this address. If you followed a saved link, the workspace may have been
          rebuilt since it was stored.
        </p>
      </header>

      <section className="panel stack" aria-labelledby="not-found-heading">
        <h2 id="not-found-heading">Nothing at this address</h2>
        <p className="error" role="alert">
          This address does not match any page in the studio.
        </p>
        <div className="actions">
          <Link to="/">Back to import</Link>
        </div>
      </section>
    </main>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
