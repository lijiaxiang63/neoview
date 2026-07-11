import type { Volume, VoxelArray, VolumeStats } from '../volume/types'
import { frameTextureSourceOf, type FrameTextureSource } from '../volume/loadVolume'
import { buildTexDataCooperative, type TexPlan } from './normalize'

/** Above this size, copying one raw frame synchronously is itself a UI stall.
 * The fallback instead derives the bounded texture cooperatively in place. */
export const MAX_WORKER_FRAME_COPY_BYTES = 16 * 1024 * 1024

export interface FrameTextureRequest {
  token: number
  dims: Volume['dims']
  raw: VoxelArray
  slope: number
  inter: number
  stats: VolumeStats
  plan: TexPlan
}

export type FrameTextureResponse =
  { ok: true; token: number; data: Uint16Array } | { ok: false; token: number }

export interface FrameTextureBuilder {
  request(
    volume: Volume,
    frame: number,
    plan: TexPlan,
    callback: (data: Uint16Array | null) => void
  ): boolean
  /** Drop current callback ownership without freeing the active slot. Work
   * already running in a retained worker cannot be recalled; keeping its
   * slot prevents target bouncing from queueing duplicate builds behind it. */
  abandon(): void
  reset(): void
  dispose(): void
}

interface Job {
  token: number
  volume: Volume
  frame: number
  plan: TexPlan
  callback: (data: Uint16Array | null) => void
  abandoned: boolean
}

export interface FrameTextureBuilderOptions {
  maxWorkerCopyBytes?: number
  cooperativeBuild?(
    volume: Volume,
    frame: number,
    plan: TexPlan,
    cancelled: () => boolean
  ): Promise<Uint16Array | null>
}

function yieldToBrowser(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (scheduler?.yield) return scheduler.yield()
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function cooperativeBuild(
  volume: Volume,
  frame: number,
  plan: TexPlan,
  cancelled: () => boolean
): Promise<Uint16Array | null> {
  return buildTexDataCooperative(volume, frame, plan, { cancelled, yieldControl: yieldToBrowser })
}

function sameJobTarget(job: Job, volume: Volume, frame: number, plan: TexPlan): boolean {
  return job.volume === volume && job.frame === frame && job.plan === plan
}

/** Latest-only frame texture client. One active build and one replaceable
 * pending target bound playback work; raw copies are limited to small frames. */
export class WorkerFrameTextureBuilder implements FrameTextureBuilder {
  private worker: Worker | null = null
  private failed = false
  private nextToken = 0
  private active: Job | null = null
  private pending: Job | null = null
  private activeSource: { source: FrameTextureSource; requestId: number } | null = null
  private disposed = false
  private readonly maxWorkerCopyBytes: number
  private readonly cooperativeBuild: NonNullable<FrameTextureBuilderOptions['cooperativeBuild']>

  constructor(
    private readonly sourceOf: (volume: Volume) => FrameTextureSource | null = frameTextureSourceOf,
    options: FrameTextureBuilderOptions = {}
  ) {
    this.maxWorkerCopyBytes = options.maxWorkerCopyBytes ?? MAX_WORKER_FRAME_COPY_BYTES
    this.cooperativeBuild = options.cooperativeBuild ?? cooperativeBuild
  }

  request(
    volume: Volume,
    frame: number,
    plan: TexPlan,
    callback: (data: Uint16Array | null) => void
  ): boolean {
    if (this.disposed) return false
    // If the target returns to the frame already being computed, transfer
    // callback ownership to that active work and discard an obsolete pending
    // target. The active response token remains valid, so no rebuild is needed.
    if (this.active && sameJobTarget(this.active, volume, frame, plan)) {
      this.active.callback = callback
      this.active.abandoned = false
      this.pending = null
      return true
    }
    if (this.pending && sameJobTarget(this.pending, volume, frame, plan)) {
      this.pending.callback = callback
      return true
    }
    const job: Job = {
      token: ++this.nextToken,
      volume,
      frame,
      plan,
      callback,
      abandoned: false
    }
    if (this.active) {
      this.pending = job
      return true
    }
    return this.post(job)
  }

  abandon(): void {
    this.pending = null
    if (!this.active) return
    this.active.abandoned = true
    this.active.callback = () => undefined
  }

  reset(): void {
    if (this.activeSource) {
      this.activeSource.source.cancel(this.activeSource.requestId)
      this.activeSource = null
    }
    const worker = this.worker
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
    }
    this.worker = null
    this.active = null
    this.pending = null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.reset()
  }

  private ensureWorker(): Worker | null {
    if (this.failed || this.disposed || typeof Worker === 'undefined') return null
    if (this.worker) return this.worker
    try {
      const worker = new Worker(new URL('./frameTextureWorker.ts', import.meta.url), {
        type: 'module'
      })
      worker.onmessage = (event: MessageEvent<FrameTextureResponse>) => {
        if (this.worker !== worker) return
        const response = event.data
        this.complete(response.token, response.ok ? response.data : null)
      }
      worker.onerror = () => {
        if (this.worker === worker) this.failWorker(worker)
      }
      this.worker = worker
    } catch {
      this.failed = true
      return null
    }
    return this.worker
  }

  private post(job: Job): boolean {
    this.active = job
    const source = this.sourceOf(job.volume)
    if (source) {
      const requestId = source.request(job.frame, job.plan, (data) =>
        this.complete(job.token, data)
      )
      if (requestId !== null) {
        if (this.active?.token === job.token) this.activeSource = { source, requestId }
        return true
      }
    }

    const voxelCount = job.volume.dims[0] * job.volume.dims[1] * job.volume.dims[2]
    const frameBytes = voxelCount * job.volume.raw.BYTES_PER_ELEMENT
    if (frameBytes > this.maxWorkerCopyBytes) return this.postCooperative(job)

    const worker = this.ensureWorker()
    // Construction can be unavailable or permanently fail after an earlier
    // worker error. Keep every later frame asynchronous and yielding instead
    // of turning that state into repeated synchronous UI work.
    if (!worker) return this.postCooperative(job)
    try {
      const offset = Math.min(job.frame, job.volume.frames - 1) * voxelCount
      const raw = job.volume.raw.slice(offset, offset + voxelCount) as VoxelArray
      const request: FrameTextureRequest = {
        token: job.token,
        dims: job.volume.dims,
        raw,
        slope: job.volume.slope,
        inter: job.volume.inter,
        stats: job.volume.stats,
        plan: job.plan
      }
      worker.postMessage(request, [raw.buffer])
      return true
    } catch {
      if (this.worker === worker) {
        this.failed = true
        worker.onmessage = null
        worker.onerror = null
        worker.terminate()
        this.worker = null
      }
      return this.postCooperative(job)
    }
  }

  private postCooperative(job: Job): true {
    let build: Promise<Uint16Array | null>
    try {
      build = this.cooperativeBuild(job.volume, job.frame, job.plan, () => {
        return (
          this.disposed ||
          this.active?.token !== job.token ||
          job.abandoned ||
          (this.pending !== null && !sameJobTarget(this.pending, job.volume, job.frame, job.plan))
        )
      })
    } catch {
      build = Promise.resolve(null)
    }
    void build.then(
      (data) => this.complete(job.token, data),
      () => this.complete(job.token, null)
    )
    return true
  }

  private complete(token: number, data: Uint16Array | null): void {
    const completed = this.active
    if (!completed || token !== completed.token) return
    this.active = null
    this.activeSource = null
    const pending = this.pending
    this.pending = null
    if (pending && !this.post(pending)) pending.callback(null)
    completed.callback(data)
  }

  private failWorker(worker: Worker): void {
    if (this.failed || this.worker !== worker) return
    this.failed = true
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
    this.worker = null
    const active = this.active
    const pending = this.pending
    this.active = null
    this.activeSource = null
    this.pending = null
    active?.callback(null)
    pending?.callback(null)
  }
}
