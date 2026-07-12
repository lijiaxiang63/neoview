import { describe, expect, it, vi } from 'vitest'
import { ModelRunner, type ModelWorkerLike } from '../src/renderer/src/model/modelRunner'
import type { ModelWorkerRequest, ModelWorkerResponse } from '../src/renderer/src/model/protocol'
import type { Volume } from '../src/renderer/src/volume/types'

const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

function volume(): Volume {
  return {
    name: 'v',
    dims: [2, 2, 2],
    frames: 1,
    spacing: [1, 1, 1],
    datatypeCode: 2,
    datatypeName: 'uint8',
    raw: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
    slope: 1,
    inter: 0,
    affine: IDENTITY.slice(),
    transformSource: 'rows',
    suggestedRange: null,
    labels: null,
    stats: { dataMin: 0, dataMax: 7, p2: 0, p98: 7, typeRange: [0, 255] }
  }
}

class FakeWorker implements ModelWorkerLike {
  onmessage: ((event: MessageEvent<ModelWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  request: ModelWorkerRequest | null = null
  transfer: Transferable[] = []
  terminate = vi.fn()

  postMessage(message: ModelWorkerRequest, transfer: Transferable[]): void {
    this.request = message
    this.transfer = transfer
  }

  respond(message: ModelWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<ModelWorkerResponse>)
  }
}

describe('ModelRunner', () => {
  it('copies and transfers input ownership while routing matching responses', () => {
    const worker = new FakeWorker()
    const runner = new ModelRunner(() => worker)
    const callbacks = {
      progress: vi.fn(),
      complete: vi.fn(),
      error: vi.fn()
    }
    const source = volume()
    expect(runner.run(4, 7, 'tissue-high', source, 'webgpu', callbacks)).toBe(true)
    expect(worker.request?.raw).not.toBe(source.raw)
    expect(worker.request?.datatypeCode).toBe(2)
    expect(worker.request?.backend).toBe('webgpu')
    expect(worker.transfer).toHaveLength(2)
    worker.respond({
      type: 'progress',
      token: 3,
      volumeSession: 7,
      variantId: 'tissue-high',
      progress: 0.5,
      stage: 'infer',
      backend: 'webgpu'
    })
    worker.respond({
      type: 'progress',
      token: 4,
      volumeSession: 7,
      variantId: 'tissue-low',
      progress: 0.4,
      stage: 'infer',
      backend: 'webgpu'
    })
    worker.respond({
      type: 'progress',
      token: 4,
      volumeSession: 7,
      variantId: 'tissue-high',
      progress: 0.5,
      stage: 'infer',
      backend: 'webgl'
    })
    expect(callbacks.progress).toHaveBeenCalledTimes(1)
    expect(callbacks.progress).toHaveBeenCalledWith(0.5, 'infer', 'webgl')
    const labels = new Uint8Array(8)
    worker.respond({
      type: 'complete',
      token: 4,
      volumeSession: 7,
      variantId: 'tissue-high',
      labels,
      counts: new Uint32Array([5, 1, 2])
    })
    expect(callbacks.complete).toHaveBeenCalledWith(labels, new Uint32Array([5, 1, 2]))
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('shares already-shared raw storage without another whole-volume copy', () => {
    const worker = new FakeWorker()
    const runner = new ModelRunner(() => worker)
    const source = volume()
    source.raw = new Uint8Array(new SharedArrayBuffer(8))
    runner.run(4, 7, 'tissue-high', source, 'webgl', {
      progress: vi.fn(),
      complete: vi.fn(),
      error: vi.fn()
    })
    expect(worker.request?.raw).toBe(source.raw)
    expect(worker.request?.backend).toBe('webgl')
    expect(worker.transfer).toEqual([worker.request?.affine.buffer])
    runner.dispose()
  })

  it('terminates replacement and disposed workers and ignores late replies', () => {
    const firstWorker = new FakeWorker()
    const secondWorker = new FakeWorker()
    const workers = [firstWorker, secondWorker]
    const runner = new ModelRunner(() => workers.shift()!)
    const first = { progress: vi.fn(), complete: vi.fn(), error: vi.fn() }
    const second = { progress: vi.fn(), complete: vi.fn(), error: vi.fn() }
    runner.run(1, 1, 'tissue-high', volume(), 'webgpu', first)
    runner.run(2, 1, 'tissue-low', volume(), 'webgpu', second)
    expect(firstWorker.terminate).toHaveBeenCalledTimes(1)
    firstWorker.respond({
      type: 'complete',
      token: 1,
      volumeSession: 1,
      variantId: 'tissue-high',
      labels: new Uint8Array(8),
      counts: new Uint32Array(3)
    })
    expect(first.complete).not.toHaveBeenCalled()
    runner.dispose()
    expect(secondWorker.terminate).toHaveBeenCalledTimes(1)
    expect(second.complete).not.toHaveBeenCalled()
  })
})
