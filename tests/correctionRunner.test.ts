import { describe, expect, it, vi } from 'vitest'
import {
  CorrectionRunner,
  type CorrectionWorkerLike
} from '../src/renderer/src/stats/correctionRunner'
import type { CorrectionRequest } from '../src/renderer/src/stats/correctionCore'
import type { CorrectionWorkerResponse } from '../src/renderer/src/stats/correctionProtocol'

class FakeWorker implements CorrectionWorkerLike {
  onmessage: ((event: MessageEvent<CorrectionWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  posted: unknown[] = []
  terminated = 0
  postMessage(message: unknown): void {
    this.posted.push(message)
  }
  terminate(): void {
    this.terminated++
  }
  deliver(response: CorrectionWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<CorrectionWorkerResponse>)
  }
}

function request(): CorrectionRequest {
  return {
    values: new Float64Array([1, 2, 3]),
    dims: [3, 1, 1],
    affine: new Float64Array(16),
    spacing: [1, 1, 1],
    statistic: { kind: 'z', dof1: 0, dof2: 0 },
    method: 'uncorrected',
    alpha: 0.05,
    clusterFormingP: 0.001,
    tail: 'two',
    connectivity: 26
  }
}

const result = (): CorrectionWorkerResponse => ({
  type: 'complete',
  token: 0,
  volumeSession: 7,
  layerId: 3,
  result: {
    statThreshold: 1.96,
    minClusterSize: null,
    mask: null,
    survivingVoxels: 2,
    smoothness: null,
    report: null
  }
})

describe('CorrectionRunner', () => {
  it('posts a run and routes a matching completion, then terminates', () => {
    const worker = new FakeWorker()
    const runner = new CorrectionRunner(() => worker)
    const complete = vi.fn()
    const ok = runner.run(0, 7, 3, request(), { complete, error: vi.fn() })
    expect(ok).toBe(true)
    expect(worker.posted).toHaveLength(1)
    worker.deliver(result())
    expect(complete).toHaveBeenCalledTimes(1)
    expect(worker.terminated).toBe(1)
  })

  it('transfers copies so the caller buffers are not detached', () => {
    const worker = new FakeWorker()
    const runner = new CorrectionRunner(() => worker)
    const req = request()
    runner.run(0, 7, 3, req, { complete: vi.fn(), error: vi.fn() })
    expect(req.values.length).toBe(3) // not detached
    const posted = worker.posted[0] as { values: Float64Array }
    expect(posted.values).not.toBe(req.values)
  })

  it('ignores a message whose scope ids do not match', () => {
    const worker = new FakeWorker()
    const runner = new CorrectionRunner(() => worker)
    const complete = vi.fn()
    runner.run(0, 7, 3, request(), { complete, error: vi.fn() })
    worker.deliver({ ...result(), layerId: 999 })
    expect(complete).not.toHaveBeenCalled()
    expect(worker.terminated).toBe(0)
  })

  it('a second run cancels the first worker', () => {
    const workers: FakeWorker[] = []
    const runner = new CorrectionRunner(() => {
      const w = new FakeWorker()
      workers.push(w)
      return w
    })
    runner.run(0, 7, 3, request(), { complete: vi.fn(), error: vi.fn() })
    runner.run(1, 7, 3, request(), { complete: vi.fn(), error: vi.fn() })
    expect(workers[0].terminated).toBe(1)
    expect(workers[1].terminated).toBe(0)
  })

  it('dispose terminates and blocks further runs', () => {
    const worker = new FakeWorker()
    const runner = new CorrectionRunner(() => worker)
    runner.run(0, 7, 3, request(), { complete: vi.fn(), error: vi.fn() })
    runner.dispose()
    expect(worker.terminated).toBe(1)
    expect(runner.run(1, 7, 3, request(), { complete: vi.fn(), error: vi.fn() })).toBe(false)
  })

  it('routes an error and terminates', () => {
    const worker = new FakeWorker()
    const runner = new CorrectionRunner(() => worker)
    const error = vi.fn()
    runner.run(0, 7, 3, request(), { complete: vi.fn(), error })
    worker.deliver({ type: 'error', token: 0, volumeSession: 7, layerId: 3, message: 'boom' })
    expect(error).toHaveBeenCalledWith('boom')
    expect(worker.terminated).toBe(1)
  })
})
