// @vitest-environment jsdom
import { QueryClient } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { Route as rootRoute } from '../src/routes/__root.js'

/**
 * Router-level proof for issue #99: an unmatched URL must render the studio's own not-found page
 * (inside the root shell, with a route back to the job list) instead of TanStack Router's bare
 * default `<p>Not Found</p>`. The tree is the real root route plus a fixture index route, so the
 * assertions cover exactly the registration in `__root.tsx` — remove it and the framework default
 * returns; remove the link and the page is a dead end.
 */

const HOME_MARKER = 'fixture home page'

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => createElement('p', null, HOME_MARKER),
})

const routeTree = rootRoute._addFileChildren({ indexRoute })

const renderAt = (path: string) => {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient: new QueryClient() },
  })
  return { router, ...render(createElement(RouterProvider, { router })) }
}

afterEach(() => {
  cleanup()
})

describe('root not-found route', () => {
  it('renders the studio not-found page, not the framework placeholder, for an unknown URL', async () => {
    renderAt('/typo-address-that-matches-nothing')

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('does not match any page')
    expect(screen.queryByText('Not Found')).toBeNull()
  })

  it('offers a link back to the job list that actually navigates', async () => {
    renderAt('/also/not/a/route')

    const back = await screen.findByRole('link', { name: 'Back to import' })
    expect(back.getAttribute('href')).toBe('/')

    await userEvent.click(back)
    expect(await screen.findByText(HOME_MARKER)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Page not found' })).toBeNull()
  })
})
