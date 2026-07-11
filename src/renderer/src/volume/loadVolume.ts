import type {
  LoadResponse,
  RetainedFrameRequest,
  RetainedFrameResponse,
  TexPayload
} from './worker'
import type { Volume } from './types'
import type { TexPlan } from '../render3d/normalize'

// The 3D texture payload rides alongside the volume without polluting the
// Volume type: keyed weakly so it is freed together with its volume. The
// lookup is deliberately non-consuming — StrictMode double-runs effects, and
// a one-shot take would force an expensive main-thread rebuild on the rerun.
const initialTex = new WeakMap<Volume, TexPayload>()
const frameSources = new WeakMap<Volume, RetainedFrameSource>()

export interface FrameTextureSource {
  request(frame: number, plan: TexPlan, callback: (data: Uint16Array | null) => void): number | null
  cancel(requestId: number): void
}

class RetainedFrameSource implements FrameTextureSource {
  private nextRequestId = 0
  private readonly callbacks = new Map<number, (data: Uint16Array | null) => void>()
  private unavailable = false

  constructor(
    private readonly worker: Worker,
    private readonly onUnavailable: () => void
  ) {
    worker.onmessage = (event: MessageEvent<RetainedFrameResponse>) => {
      const response = event.data
      if (this.unavailable || response.kind !== 'frame') return
      const callback = this.callbacks.get(response.token)
      if (!callback) return
      this.callbacks.delete(response.token)
      callback(response.ok ? response.data : null)
    }
    worker.onerror = () => this.fail(true)
  }

  request(
    frame: number,
    plan: TexPlan,
    callback: (data: Uint16Array | null) => void
  ): number | null {
    if (this.unavailable) return null
    const requestId = ++this.nextRequestId
    this.callbacks.set(requestId, callback)
    const request: RetainedFrameRequest = { kind: 'frame', token: requestId, frame, plan }
    try {
      this.worker.postMessage(request)
    } catch {
      this.fail(true)
    }
    return requestId
  }

  cancel(requestId: number): void {
    this.callbacks.delete(requestId)
  }

  dispose(): void {
    this.fail(false)
  }

  private fail(notify: boolean): void {
    if (this.unavailable) return
    this.unavailable = true
    this.worker.onmessage = null
    this.worker.onerror = null
    this.worker.terminate()
    const callbacks = [...this.callbacks.values()]
    this.callbacks.clear()
    this.onUnavailable()
    if (notify) for (const callback of callbacks) callback(null)
  }
}

function retainFrameSource(volume: Volume, worker: Worker): void {
  const source = new RetainedFrameSource(worker, () => {
    if (frameSources.get(volume) === source) frameSources.delete(volume)
  })
  frameSources.set(volume, source)
}

export function frameTextureSourceOf(volume: Volume): FrameTextureSource | null {
  return frameSources.get(volume) ?? null
}

export function releaseFrameTextureSource(volume: Volume): void {
  const source = frameSources.get(volume)
  if (!source) return
  frameSources.delete(volume)
  source.dispose()
}

/** Worker-built texture payload for a freshly loaded volume, if available. */
export function initialTexOf(vol: Volume): TexPayload | null {
  return initialTex.get(vol) ?? null
}

/** Release the worker-built frame-0 staging payload after the stable
 * controller has moved to another frame. StrictMode replay happens before any
 * user frame change, so the second controller has already consumed it. */
export function releaseInitialTex(vol: Volume): void {
  initialTex.delete(vol)
}

/**
 * Load a volume off the main thread. Multi-frame base volumes retain the load
 * worker only when raw samples can be shared with the renderer; later texture
 * requests then send frame/plan tokens without a main-thread raw copy.
 */
export function loadVolume(
  name: string,
  bytes: ArrayBuffer,
  opts?: { skipTex?: boolean; signal?: AbortSignal }
): Promise<Volume> {
  return new Promise((resolve, reject) => {
    const signal = opts?.signal
    const cancelled = (): Error => {
      const error = new Error('Load cancelled.')
      error.name = 'AbortError'
      return error
    }
    if (signal?.aborted) {
      reject(cancelled())
      return
    }

    let worker: Worker
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    } catch {
      reject(new Error('Could not open file.'))
      return
    }
    let settled = false
    const finish = (fn: () => void, retainWorker = false): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (!retainWorker) {
        worker.onmessage = null
        worker.onerror = null
        worker.terminate()
      }
      fn()
    }
    const onAbort = (): void => finish(() => reject(cancelled()))
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.onmessage = (e: MessageEvent<LoadResponse>) => {
      const msg = e.data
      const retainWorker = msg.ok && msg.frameSource === true
      finish(() => {
        if (msg.ok) {
          if (msg.tex) initialTex.set(msg.volume, msg.tex)
          if (retainWorker) retainFrameSource(msg.volume, worker)
          resolve(msg.volume)
        } else {
          reject(new Error(msg.message))
        }
      }, retainWorker)
    }
    worker.onerror = () => {
      finish(() => reject(new Error('Could not open file.')))
    }
    try {
      worker.postMessage({ name, bytes, skipTex: opts?.skipTex }, [bytes])
    } catch {
      finish(() => reject(new Error('Could not open file.')))
    }
  })
}
