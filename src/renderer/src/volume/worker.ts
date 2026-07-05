// Off-main-thread loading: decompress, parse, compute stats, and build the
// 3D texture payload here so the UI stays responsive during multi-hundred-MB
// work. Buffers cross back via transfer, so the only main-thread cost is a
// structured-clone of metadata.
import { gunzip, isGzip } from './gunzip'
import { parseVolume } from './parse'
import { ParseError, type Volume } from './types'
import { buildTexData, planTexture, type TexPlan } from '../render3d/normalize'

export interface LoadRequest {
  name: string
  bytes: ArrayBuffer
}

export interface TexPayload {
  plan: TexPlan
  data: Uint16Array
}

export type LoadResponse =
  { ok: true; volume: Volume; tex: TexPayload } | { ok: false; code: string; message: string }

const post = self.postMessage.bind(self) as (msg: LoadResponse, transfer?: Transferable[]) => void

self.onmessage = async (e: MessageEvent<LoadRequest>): Promise<void> => {
  try {
    const bytes = isGzip(e.data.bytes) ? await gunzip(e.data.bytes) : e.data.bytes
    const volume = parseVolume(e.data.name, bytes)
    const plan = planTexture(volume.dims, volume.spacing)
    const data = buildTexData(volume, 0, plan)
    post({ ok: true, volume, tex: { plan, data } }, [volume.raw.buffer, data.buffer])
  } catch (err) {
    post({
      ok: false,
      code: err instanceof ParseError ? err.code : 'load-failed',
      message: err instanceof Error ? err.message : 'Could not open file.'
    })
  }
}
