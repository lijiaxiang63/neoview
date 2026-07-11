// Off-main-thread loading: decompress, parse, compute stats, and build the
// 3D texture payload here so the UI stays responsive during multi-hundred-MB
// work. Buffers cross back via transfer, so the only main-thread cost is a
// structured-clone of metadata.
import { gunzip, isGzip } from './gunzip'
import { parseVolume } from './parse'
import { ParseError, type Volume } from './types'
import { shareVolumeRaw } from './sharedRaw'
import { buildTexData, planTexture, type TexPlan } from '../render3d/normalize'

export interface LoadRequest {
  kind?: 'load'
  name: string
  bytes: ArrayBuffer
  /** Skip the 3D texture build — overlay layers only feed the slice views. */
  skipTex?: boolean
}

export interface TexPayload {
  plan: TexPlan
  data: Uint16Array
}

export interface RetainedFrameRequest {
  kind: 'frame'
  token: number
  frame: number
  plan: TexPlan
}

export type RetainedFrameResponse =
  | { kind: 'frame'; ok: true; token: number; data: Uint16Array }
  | { kind: 'frame'; ok: false; token: number }

export type LoadResponse =
  | { ok: true; volume: Volume; tex: TexPayload | null; frameSource?: boolean }
  | { ok: false; code: string; message: string }

type WorkerResponse = LoadResponse | RetainedFrameResponse

const post = self.postMessage.bind(self) as (msg: WorkerResponse, transfer?: Transferable[]) => void
let retainedVolume: Volume | null = null

self.onmessage = async (e: MessageEvent<LoadRequest | RetainedFrameRequest>): Promise<void> => {
  if ('kind' in e.data && e.data.kind === 'frame') {
    try {
      if (!retainedVolume) throw new Error('Frame source unavailable.')
      const data = buildTexData(retainedVolume, e.data.frame, e.data.plan)
      post({ kind: 'frame', ok: true, token: e.data.token, data }, [data.buffer])
    } catch {
      post({ kind: 'frame', ok: false, token: e.data.token })
    }
    return
  }
  try {
    const bytes = isGzip(e.data.bytes) ? await gunzip(e.data.bytes) : e.data.bytes
    const volume = parseVolume(e.data.name, bytes)
    if (e.data.skipTex) {
      post({ ok: true, volume, tex: null }, [volume.raw.buffer])
      return
    }
    const plan = planTexture(volume.dims, volume.spacing)
    const data = buildTexData(volume, 0, plan)
    const frameSource = volume.frames > 1 && shareVolumeRaw(volume)
    retainedVolume = frameSource ? volume : null
    if (frameSource) {
      post({ ok: true, volume, tex: { plan, data }, frameSource: true }, [data.buffer])
    } else {
      post({ ok: true, volume, tex: { plan, data } }, [volume.raw.buffer, data.buffer])
    }
  } catch (err) {
    post({
      ok: false,
      code: err instanceof ParseError ? err.code : 'load-failed',
      message: err instanceof Error ? err.message : 'Could not open file.'
    })
  }
}
