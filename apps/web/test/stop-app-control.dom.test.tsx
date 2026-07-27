// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AudiobookClient } from '../src/client/audiobook-client.js'
import { StopAppControl } from '../src/components/stop-app-control.js'

const clientWithPreview = (inFlight: Awaited<ReturnType<AudiobookClient['getStopPreview']>>) =>
  ({ getStopPreview: vi.fn(async () => inFlight) }) as unknown as AudiobookClient

afterEach(cleanup)

describe('Stop app browser control', () => {
  it('names in-flight work before confirmation and shows a stopped state after acknowledgement', async () => {
    const user = userEvent.setup()
    let acknowledge: ((response: Response) => void) | undefined
    const requestStop = vi.fn(
      async () =>
        await new Promise<Response>((resolve) => {
          acknowledge = resolve
        }),
    )
    const client = clientWithPreview({
      ok: true,
      value: {
        inFlight: {
          jobId: 'job-preview-stop',
          operation: 'Rendering speech for Chapter 2',
          checkpoint: 'Resume verifies saved segment audio and renders only what is missing.',
        },
      },
    })
    render(<StopAppControl client={client} requestStop={requestStop} />)

    await user.click(screen.getByRole('button', { name: 'Stop app' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('Rendering speech for Chapter 2')
    expect(dialog.textContent).toContain('renders only what is missing')

    await user.click(screen.getByRole('button', { name: 'Stop now and free the GPU' }))
    expect(
      (screen.getByRole('button', { name: 'Releasing resources…' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(screen.queryByText('The local server has stopped')).toBeNull()

    acknowledge?.(Response.json({ stopped: true }))
    expect(await screen.findByText('The local server has stopped')).toBeTruthy()
    expect(screen.getByText(/Model processes and GPU resources were released/)).toBeTruthy()
    expect(screen.queryByText(/could not be stopped/i)).toBeNull()
  })

  it('says plainly when nothing is running before stopping', async () => {
    const user = userEvent.setup()
    const client = clientWithPreview({ ok: true, value: { inFlight: null } })
    render(
      <StopAppControl client={client} requestStop={async () => Response.json({ stopped: true })} />,
    )

    await user.click(screen.getByRole('button', { name: 'Stop app' }))
    expect(await screen.findByText('No generation is in flight.')).toBeTruthy()
  })
})
