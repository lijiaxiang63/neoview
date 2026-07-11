import type { Volume, VoxelArray } from '../volume/types'
import type { ModelVariantId } from './catalog'
import { modelAvailability, type ModelAvailability } from './preprocess'
import {
  modelErrorMessage,
  type ModelErrorCode,
  type ModelProgressStage,
  type ModelWorkerRequest,
  type ModelWorkerResponse
} from './protocol'

export interface ModelWorkerLike {
  onmessage: ((event: MessageEvent<ModelWorkerResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: ModelWorkerRequest, transfer: Transferable[]): void
  terminate(): void
}

export type ModelWorkerFactory = () => ModelWorkerLike

export interface ModelRunCallbacks {
  progress(value: number, stage: ModelProgressStage): void
  complete(labels: Uint8Array, counts: Uint32Array): void
  error(code: ModelErrorCode, message: string): void
}

export interface ModelController {
  availability(volume: Volume | null): ModelAvailability
  run(
    token: number,
    volumeSession: number,
    variantId: ModelVariantId,
    volume: Volume,
    callbacks: ModelRunCallbacks
  ): boolean
  cancel(): void
  dispose(): void
}

const createBrowserWorker: ModelWorkerFactory = () =>
  new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })

function prepareRaw(raw: VoxelArray): { raw: VoxelArray; transfer: Transferable[] } {
  if (typeof SharedArrayBuffer !== 'undefined' && raw.buffer instanceof SharedArrayBuffer) {
    return { raw, transfer: [] }
  }
  const copy = raw.slice() as VoxelArray
  return { raw: copy, transfer: [copy.buffer as ArrayBuffer] }
}

export class ModelRunner implements ModelController {
  private worker: ModelWorkerLike | null = null
  private disposed = false

  constructor(private readonly createWorker: ModelWorkerFactory = createBrowserWorker) {}

  availability(volume: Volume | null): ModelAvailability {
    if (this.disposed) return { available: false, reason: 'Model execution is unavailable.' }
    if (typeof Worker === 'undefined' && this.createWorker === createBrowserWorker) {
      return { available: false, reason: 'Model execution is unavailable.' }
    }
    return modelAvailability(volume)
  }

  run(
    token: number,
    volumeSession: number,
    variantId: ModelVariantId,
    volume: Volume,
    callbacks: ModelRunCallbacks
  ): boolean {
    if (this.disposed || !this.availability(volume).available) return false
    this.cancel()
    let worker: ModelWorkerLike
    try {
      worker = this.createWorker()
    } catch {
      callbacks.error('unsupported', modelErrorMessage('unsupported'))
      return false
    }
    this.worker = worker
    worker.onmessage = (event) => {
      if (this.disposed || this.worker !== worker) return
      const message = event.data
      if (
        message.token !== token ||
        message.volumeSession !== volumeSession ||
        message.variantId !== variantId
      )
        return
      if (message.type === 'progress') callbacks.progress(message.progress, message.stage)
      else if (message.type === 'complete') {
        this.release(worker)
        callbacks.complete(message.labels, message.counts)
      } else {
        this.release(worker)
        callbacks.error(message.code, modelErrorMessage(message.code))
      }
    }
    worker.onerror = () => {
      if (this.disposed || this.worker !== worker) return
      this.release(worker)
      callbacks.error('run-failed', modelErrorMessage('run-failed'))
    }
    const preparedRaw = prepareRaw(volume.raw)
    const request: ModelWorkerRequest = {
      type: 'run',
      token,
      volumeSession,
      variantId,
      dims: volume.dims,
      affine: volume.affine.slice(),
      datatypeCode: volume.datatypeCode,
      slope: volume.slope,
      inter: volume.inter,
      raw: preparedRaw.raw
    }
    try {
      worker.postMessage(request, [...preparedRaw.transfer, request.affine.buffer])
    } catch {
      this.release(worker)
      callbacks.error('run-failed', modelErrorMessage('run-failed'))
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

  private release(worker: ModelWorkerLike): void {
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
    if (this.worker === worker) this.worker = null
  }
}
