import { buildTexData } from './normalize'
import type { FrameTextureRequest, FrameTextureResponse } from './frameTextureClient'

const post = self.postMessage.bind(self) as (
  response: FrameTextureResponse,
  transfer?: Transferable[]
) => void

self.onmessage = (event: MessageEvent<FrameTextureRequest>) => {
  const request = event.data
  try {
    const data = buildTexData(
      {
        dims: request.dims,
        frames: 1,
        raw: request.raw,
        slope: request.slope,
        inter: request.inter,
        stats: request.stats
      } as Parameters<typeof buildTexData>[0],
      0,
      request.plan
    )
    post({ ok: true, token: request.token, data }, [data.buffer])
  } catch {
    post({ ok: false, token: request.token })
  }
}
