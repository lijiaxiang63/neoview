import type { Volume } from '../volume/types'
import type { OverlayLayer } from '../slicing/overlay'
import type { AlignedGridSource, SegmentResult } from './segment'
import type { ComputeRequest, ConstraintSpec, FromWorker, ToWorker } from './previewCore'

/**
 * Main-thread side of the preview worker. Lazily spawns one persistent
 * worker and mirrors into it whatever grids a request needs — the base
 * volume once per volume, each constraint overlay once, the label map
 * whenever its revision moved. Mirroring costs one copy of the buffer (the
 * main thread keeps using its own), which is why the store only routes
 * requests here when the flood bounds are big enough to jank the UI.
 *
 * Exactly one compute is in flight at a time; a newer request simply
 * replaces the callback (the worker's FIFO makes older results arrive first,
 * and the store drops them by token).
 */
export class PreviewClient {
  private worker: Worker | null = null
  private failed = false
  private sentVolume: Volume | null = null
  private sentLabelRev = -1
  private sentOverlays = new Set<number>()
  private onResult: ((token: number, result: SegmentResult | null) => void) | null = null

  available(): boolean {
    return typeof Worker !== 'undefined' && !this.failed
  }

  private ensureWorker(): Worker | null {
    if (this.failed) return null
    if (!this.worker) {
      try {
        this.worker = new Worker(new URL('./previewWorker.ts', import.meta.url), {
          type: 'module'
        })
      } catch {
        this.failed = true
        return null
      }
      this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const msg = e.data
        this.onResult?.(msg.token, msg.type === 'result' ? msg.result : null)
      }
      this.worker.onerror = () => {
        // A dead worker (e.g. it failed to load) must not strand previews:
        // flag it so the store's synchronous path takes over for good.
        this.failed = true
        this.worker?.terminate()
        this.worker = null
        this.onResult?.(-1, null)
      }
    }
    return this.worker
  }

  private grid(vol: Volume): { grid: AlignedGridSource; transfer: Transferable[] } {
    // The worker gets its own copy; the main thread keeps reading the
    // original for slice extraction.
    const raw = vol.raw.slice()
    return {
      grid: {
        dims: vol.dims,
        raw,
        slope: vol.slope,
        inter: vol.inter,
        affine: vol.affine,
        frames: vol.frames
      },
      transfer: [raw.buffer]
    }
  }

  /**
   * Post one compute. Returns false when the worker (or a grid it would
   * need) is unavailable — the caller should compute synchronously instead.
   * `onResult` receives the token and the result (null = worker-side miss;
   * fall back synchronously).
   */
  request(
    vol: Volume,
    labelMap: Uint16Array | null,
    labelMapRev: number,
    overlays: OverlayLayer[],
    req: Omit<ComputeRequest, 'constraint'> & { constraint: ConstraintSpec },
    onResult: (token: number, result: SegmentResult | null) => void
  ): boolean {
    const worker = this.ensureWorker()
    if (!worker) return false

    if (this.sentVolume !== vol) {
      const { grid, transfer } = this.grid(vol)
      const msg: ToWorker = { type: 'volume', grid }
      worker.postMessage(msg, transfer)
      this.sentVolume = vol
      this.sentLabelRev = -1
      this.sentOverlays.clear()
    }
    if (req.constraint.type === 'overlay') {
      const wanted = req.constraint.overlayId
      const layer = overlays.find((l) => l.id === wanted)
      if (!layer) return false
      if (!this.sentOverlays.has(layer.id)) {
        const { grid, transfer } = this.grid(layer.volume)
        const msg: ToWorker = { type: 'overlay', id: layer.id, grid }
        worker.postMessage(msg, transfer)
        this.sentOverlays.add(layer.id)
      }
    } else if (req.constraint.type === 'region') {
      if (!labelMap) return false
      if (this.sentLabelRev !== labelMapRev) {
        const data = labelMap.slice()
        const msg: ToWorker = { type: 'labelMap', data }
        worker.postMessage(msg, [data.buffer])
        this.sentLabelRev = labelMapRev
      }
    }

    this.onResult = onResult
    const msg: ToWorker = { type: 'compute', req }
    worker.postMessage(msg)
    return true
  }
}
