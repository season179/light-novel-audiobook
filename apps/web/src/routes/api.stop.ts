import { createFileRoute } from '@tanstack/react-router'
import { type AudiobookComposition, getAudiobookComposition } from '../server/composition-root.js'

/** State-changing by design, so the global anti-CSRF middleware never exempts this endpoint. */
export const STOP_ENDPOINT_METHOD = 'POST' as const

export const stopAppResponse = async (composition: AudiobookComposition): Promise<Response> => {
  try {
    await composition.shutdown.prepare()
    const response = Response.json({ stopped: true }, { headers: { 'Cache-Control': 'no-store' } })
    // Deliberately after the response exists. The injected scheduler gives the HTTP adapter time to
    // flush it before the one normal process exit closes the launcher window.
    composition.shutdown.exitAfterResponse()
    return response
  } catch (error) {
    console.error('stopApp failed', error)
    return Response.json(
      { stopped: false, message: 'The local server could not release every owned resource.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}

/** POST only: GET would be exempt from the existing anti-CSRF cover. */
export const Route = createFileRoute('/api/stop')({
  server: {
    handlers: {
      [STOP_ENDPOINT_METHOD]: async () => stopAppResponse(await getAudiobookComposition()),
    },
  },
})
