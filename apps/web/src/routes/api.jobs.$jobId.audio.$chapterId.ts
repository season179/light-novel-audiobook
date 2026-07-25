import { createFileRoute } from '@tanstack/react-router'
import { audioFileErrorResponse, audioFileResponse } from '../server/audio-file-response.js'
import { getAudiobookWebApi } from '../server/composition-root.js'

/** Chapter audio for the in-page player. The path comes from persisted job output only. */
export const Route = createFileRoute('/api/jobs/$jobId/audio/$chapterId')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const api = await getAudiobookWebApi()
          return audioFileResponse(
            await api.openChapterAudioFile({
              jobId: params.jobId,
              chapterId: params.chapterId,
            }),
          )
        } catch (error) {
          return audioFileErrorResponse(error, 'openChapterAudioFile')
        }
      },
    },
  },
})
