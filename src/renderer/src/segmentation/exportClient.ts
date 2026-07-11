import type { ExportFormat, ExportPayload, ExportVolume } from './exportRegions'
import type { ExportWorkerRequest, ExportWorkerResponse } from './exportWorker'
import type { Region } from './regions'

export interface ExportWorkerLike {
  onmessage: ((event: MessageEvent<ExportWorkerResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: ExportWorkerRequest, transfer: Transferable[]): void
  terminate(): void
}

export type ExportWorkerFactory = () => ExportWorkerLike

const createBrowserWorker: ExportWorkerFactory = () =>
  new Worker(new URL('./exportWorker.ts', import.meta.url), {
    type: 'module',
    name: 'region-export'
  })

function abortError(): Error {
  const error = new Error('Export cancelled.')
  error.name = 'AbortError'
  return error
}

export class RegionExportClient {
  private readonly createWorker: ExportWorkerFactory
  private nextToken = 0
  private active: {
    token: number
    worker: ExportWorkerLike
    reject(error: unknown): void
  } | null = null
  private disposed = false

  constructor(createWorker: ExportWorkerFactory = createBrowserWorker) {
    this.createWorker = createWorker
  }

  build(
    kind: 'labels' | 'mask',
    volume: ExportVolume,
    labelMap: Uint16Array,
    regions: Region[],
    format: ExportFormat
  ): Promise<ExportPayload> {
    if (this.disposed) return Promise.reject(abortError())
    this.cancelActive()
    const token = ++this.nextToken
    const worker = this.createWorker()
    // The store mutates its label map in place. Transfer a snapshot so worker
    // ownership can never detach or race the live editing buffer.
    const snapshot = labelMap.slice()
    // `Pick` is compile-time only: project the real Volume explicitly or its
    // large enumerable raw buffer would be structured-cloned into the worker.
    const workerVolume: ExportVolume = {
      name: volume.name,
      dims: volume.dims,
      spacing: volume.spacing,
      affine: volume.affine
    }
    return new Promise<ExportPayload>((resolve, reject) => {
      this.active = { token, worker, reject }
      const finish = (callback: () => void): void => {
        if (this.active?.token !== token) return
        this.active = null
        worker.terminate()
        callback()
      }
      worker.onmessage = (event) => {
        const response = event.data
        if (response.token !== token) return
        if (response.ok) finish(() => resolve(response.payload))
        else finish(() => reject(new Error(response.message)))
      }
      worker.onerror = (event) => {
        finish(() => reject(new Error(event.message || 'Export worker failed.')))
      }
      const request: ExportWorkerRequest = {
        token,
        kind,
        volume: workerVolume,
        labelMap: snapshot,
        regions,
        format
      }
      worker.postMessage(request, [snapshot.buffer])
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelActive()
  }

  private cancelActive(): void {
    const active = this.active
    if (!active) return
    this.active = null
    active.worker.terminate()
    active.reject(abortError())
  }
}
