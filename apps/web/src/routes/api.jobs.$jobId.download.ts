import { createFileRoute } from '@tanstack/react-router'
import { audioFileErrorResponse, audioFileResponse } from '../server/audio-file-response.js'
import { getAudiobookWebApi } from '../server/composition-root.js'

/** Downloads the numbered M4B for a completed job. */
export const Route = createFileRoute('/api/jobs/$jobId/download')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const api = await getAudiobookWebApi()
          return audioFileResponse(await api.readAudiobookFile({ jobId: params.jobId }))
        } catch (error) {
          return audioFileErrorResponse(error)
        }
      },
    },
  },
})
