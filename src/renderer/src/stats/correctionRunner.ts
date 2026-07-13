// Owns the correction worker lifecycle: one fresh module worker per run, scoped
// by (token, volumeSession, layerId), with cancel/dispose that terminate
// immediately. Mirrors the model runner. When Workers are unavailable (tests,
// SSR), run() returns false so the caller falls back to a synchronous compute.

import type { CorrectionRequest, CorrectionResult } from './correctionCore'
import type {
  CorrectionProgressStage,
  CorrectionWorkerRequest,
  CorrectionWorkerResponse
} from './correctionProtocol'

export interface CorrectionWorkerLike {
  onmessage: ((event: MessageEvent<CorrectionWorkerResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: CorrectionWorkerRequest, transfer: Transferable[]): void
  terminate(): void
}

export type CorrectionWorkerFactory = () => CorrectionWorkerLike

export interface CorrectionRunCallbacks {
  progress?(stage: CorrectionProgressStage, value: number): void
  complete(result: CorrectionResult): void
  error(message: string): void
}

export interface CorrectionController {
  run(
    token: number,
    volumeSession: number,
    layerId: number,
    request: CorrectionRequest,
    callbacks: CorrectionRunCallbacks
  ): boolean
  cancel(): void
  dispose(): void
}

const createBrowserWorker: CorrectionWorkerFactory = () =>
  new Worker(new URL('./correctionWorker.ts', import.meta.url), {
    type: 'module',
    name: 'stats-correction'
  })

export class CorrectionRunner implements CorrectionController {
  private worker: CorrectionWorkerLike | null = null
  private disposed = false

  constructor(private readonly createWorker: CorrectionWorkerFactory = createBrowserWorker) {}

  private available(): boolean {
    if (this.disposed) return false
    return typeof Worker !== 'undefined' || this.createWorker !== createBrowserWorker
  }

  run(
    token: number,
    volumeSession: number,
    layerId: number,
    request: CorrectionRequest,
    callbacks: CorrectionRunCallbacks
  ): boolean {
    if (!this.available()) return false
    this.cancel()
    let worker: CorrectionWorkerLike
    try {
      worker = this.createWorker()
    } catch {
      return false
    }
    this.worker = worker
    worker.onmessage = (event): void => {
      if (this.disposed || this.worker !== worker) return
      const message = event.data
      if (
        message.token !== token ||
        message.volumeSession !== volumeSession ||
        message.layerId !== layerId
      )
        return
      if (message.type === 'progress') {
        callbacks.progress?.(message.stage, message.progress)
      } else if (message.type === 'complete') {
        this.release(worker)
        callbacks.complete(message.result)
      } else {
        this.release(worker)
        callbacks.error(message.message)
      }
    }
    worker.onerror = (): void => {
      if (this.disposed || this.worker !== worker) return
      this.release(worker)
      callbacks.error('Correction worker failed.')
    }
    // Transfer copies of the buffers the worker consumes so the caller's cached
    // arrays are never detached.
    const values = request.values.slice()
    const affine = request.affine.slice()
    const message: CorrectionWorkerRequest = {
      ...request,
      values,
      affine,
      type: 'run',
      token,
      volumeSession,
      layerId
    }
    try {
      worker.postMessage(message, [values.buffer, affine.buffer])
    } catch {
      this.release(worker)
      return false
    }
    return true
  }

  cancel(): void {
    if (this.worker) this.release(this.worker)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel()
  }

  private release(worker: CorrectionWorkerLike): void {
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
    if (this.worker === worker) this.worker = null
  }
}
