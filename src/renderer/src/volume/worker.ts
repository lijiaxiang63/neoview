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
  /** Skip the 3D texture build — overlay layers only feed the slice views. */
  skipTex?: boolean
}

export interface TexPayload {
  plan: TexPlan
  data: Uint16Array
}

export type LoadResponse =
  | { ok: true; volume: Volume; tex: TexPayload | null }
  | { ok: false; code: string; message: string }

const post = self.postMessage.bind(self) as (msg: LoadResponse, transfer?: Transferable[]) => void

self.onmessage = async (e: MessageEvent<LoadRequest>): Promise<void> => {
  try {
    const bytes = isGzip(e.data.bytes) ? await gunzip(e.data.bytes) : e.data.bytes
    const volume = parseVolume(e.data.name, bytes)
    if (e.data.skipTex) {
      post({ ok: true, volume, tex: null }, [volume.raw.buffer])
      return
    }
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
