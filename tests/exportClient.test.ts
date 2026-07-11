import { describe, expect, it } from 'vitest'
import {
  RegionExportClient,
  type ExportWorkerLike
} from '../src/renderer/src/segmentation/exportClient'
import type {
  ExportWorkerRequest,
  ExportWorkerResponse
} from '../src/renderer/src/segmentation/exportWorker'
import type { ExportVolume } from '../src/renderer/src/segmentation/exportRegions'

class FakeWorker implements ExportWorkerLike {
  onmessage: ((event: MessageEvent<ExportWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  request: ExportWorkerRequest | null = null
  transfer: Transferable[] = []
  terminated = false

  postMessage(message: ExportWorkerRequest, transfer: Transferable[]): void {
    this.request = message
    this.transfer = transfer
  }

  terminate(): void {
    this.terminated = true
  }

  respond(response: ExportWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<ExportWorkerResponse>)
  }
}

const volume: ExportVolume = {
  name: 'base.nii',
  dims: [2, 1, 1],
  spacing: [1, 1, 1],
  affine: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

describe('RegionExportClient', () => {
  it('transfers an isolated label-map snapshot and terminates after delivery', async () => {
    const worker = new FakeWorker()
    const client = new RegionExportClient(() => worker)
    const live = new Uint16Array([1, 2])
    const fullVolume = {
      ...volume,
      raw: new Uint8Array(1024),
      frames: 1,
      datatypeCode: 2
    }
    const pending = client.build('labels', fullVolume, live, [], 'nii')

    expect(worker.request?.labelMap).not.toBe(live)
    expect([...worker.request!.labelMap]).toEqual([1, 2])
    expect(worker.transfer).toEqual([worker.request!.labelMap.buffer])
    expect(live.byteLength).toBe(4)
    expect(worker.request?.volume).toEqual(volume)
    expect(worker.request?.volume).not.toHaveProperty('raw')

    const bytes = new ArrayBuffer(3)
    worker.respond({
      token: worker.request!.token,
      ok: true,
      payload: { fileName: 'base.regions.nii', bytes, sidecar: null }
    })

    await expect(pending).resolves.toMatchObject({ fileName: 'base.regions.nii', bytes })
    expect(worker.terminated).toBe(true)
  })

  it('cancels owned work on dispose and ignores its late response', async () => {
    const worker = new FakeWorker()
    const client = new RegionExportClient(() => worker)
    const pending = client.build('mask', volume, new Uint16Array([1, 0]), [], 'nii.gz')
    const token = worker.request!.token

    client.dispose()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminated).toBe(true)

    worker.respond({
      token,
      ok: true,
      payload: { fileName: 'late.nii', bytes: new ArrayBuffer(0), sidecar: null }
    })
  })
})
