import {
  applyMessage,
  computeInCache,
  emptyCache,
  type FromWorker,
  type ToWorker
} from './previewCore'

// Persistent preview worker: holds copies of the grids the client sent and
// runs the segmentation engine off the main thread. All protocol logic lives
// in previewCore.ts (unit-tested); this file is only the message pump.

const cache = emptyCache()
const post = self.postMessage.bind(self) as (msg: FromWorker, transfer?: Transferable[]) => void

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data
  if (msg.type !== 'compute') {
    applyMessage(cache, msg)
    return
  }
  const { token } = msg.req
  try {
    const result = computeInCache(cache, msg.req)
    if (!result) {
      post({ type: 'error', token })
      return
    }
    post({ type: 'result', token, result }, [result.mask.buffer])
  } catch {
    post({ type: 'error', token })
  }
}
