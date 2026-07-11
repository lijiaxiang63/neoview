import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WorkerFrameTextureBuilder,
  type FrameTextureRequest,
  type FrameTextureResponse
} from '../src/renderer/src/render3d/frameTextureClient'
import { planTexture } from '../src/renderer/src/render3d/normalize'
import type { Volume } from '../src/renderer/src/volume/types'
import type { FrameTextureSource } from '../src/renderer/src/volume/loadVolume'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent<FrameTextureResponse>) => void) | null = null
  onerror: (() => void) | null = null
  readonly posted: FrameTextureRequest[] = []
  readonly terminate = vi.fn()

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(message: FrameTextureRequest): void {
    this.posted.push(message)
  }

  respond(response: FrameTextureResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<FrameTextureResponse>)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeWorker.instances.length = 0
})

function volume(): Volume {
  return {
    name: 'frames',
    dims: [2, 1, 1],
    frames: 3,
    spacing: [1, 1, 1],
    datatypeCode: 2,
    datatypeName: 'uint8',
    raw: new Uint8Array([1, 2, 3, 4, 5, 6]),
    slope: 1,
    inter: 0,
    affine: new Float64Array(16),
    transformSource: 'spacing-fallback',
    suggestedRange: null,
    labels: null,
    stats: { dataMin: 1, dataMax: 6, p2: 1, p98: 6, typeRange: [0, 255] }
  }
}

describe('frame texture worker client', () => {
  it('uses a retained source without copying or posting raw samples on the main thread', () => {
    vi.stubGlobal('Worker', FakeWorker)
    const sourceVolume = volume()
    const plan = planTexture(sourceVolume.dims, sourceVolume.spacing)
    let complete: ((data: Uint16Array | null) => void) | null = null
    const source: FrameTextureSource = {
      request: vi.fn((_frame, _plan, callback) => {
        complete = callback
        return 41
      }),
      cancel: vi.fn()
    }
    const builder = new WorkerFrameTextureBuilder(() => source)
    const callback = vi.fn()

    expect(builder.request(sourceVolume, 2, plan, callback)).toBe(true)
    expect(source.request).toHaveBeenCalledWith(2, plan, expect.any(Function))
    expect(FakeWorker.instances).toHaveLength(0)
    complete!(new Uint16Array([7, 7]))
    expect(callback).toHaveBeenCalledWith(new Uint16Array([7, 7]))
  })

  it('keeps a retained-source build active while applied-frame bounces abandon it', () => {
    const sourceVolume = volume()
    const plan = planTexture(sourceVolume.dims, sourceVolume.spacing)
    const completions: Array<(data: Uint16Array | null) => void> = []
    const source: FrameTextureSource = {
      request: vi.fn((_frame, _plan, callback) => {
        completions.push(callback)
        return completions.length
      }),
      cancel: vi.fn()
    }
    const builder = new WorkerFrameTextureBuilder(() => source)
    const first = vi.fn()
    const returned = vi.fn()

    builder.request(sourceVolume, 1, plan, first)
    builder.abandon()
    builder.request(sourceVolume, 1, plan, returned)
    builder.abandon()

    expect(source.request).toHaveBeenCalledTimes(1)
    completions[0](new Uint16Array([3, 3]))
    expect(first).not.toHaveBeenCalled()
    expect(returned).not.toHaveBeenCalled()
    expect(source.request).toHaveBeenCalledTimes(1)
  })

  it('copies only one frame and keeps only the latest pending request', () => {
    vi.stubGlobal('Worker', FakeWorker)
    const source = volume()
    const plan = planTexture(source.dims, source.spacing)
    const builder = new WorkerFrameTextureBuilder()
    const first = vi.fn()
    const latest = vi.fn()

    expect(builder.request(source, 1, plan, first)).toBe(true)
    expect(builder.request(source, 2, plan, latest)).toBe(true)
    const worker = FakeWorker.instances[0]
    expect(worker.posted).toHaveLength(1)
    expect(Array.from(worker.posted[0].raw)).toEqual([3, 4])

    worker.respond({ ok: true, token: worker.posted[0].token, data: new Uint16Array([1, 1]) })
    expect(first).toHaveBeenCalledTimes(1)
    expect(worker.posted).toHaveLength(2)
    expect(Array.from(worker.posted[1].raw)).toEqual([5, 6])
    worker.respond({ ok: true, token: worker.posted[1].token, data: new Uint16Array([2, 2]) })
    expect(latest).toHaveBeenCalledTimes(1)

    builder.dispose()
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('builds a large unshared frame cooperatively without a raw frame copy or worker', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const source = volume()
    const plan = planTexture(source.dims, source.spacing)
    const result = deferred<Uint16Array | null>()
    const cooperativeBuild = vi.fn(() => result.promise)
    const builder = new WorkerFrameTextureBuilder(() => null, {
      maxWorkerCopyBytes: 1,
      cooperativeBuild
    })
    const callback = vi.fn()

    expect(builder.request(source, 1, plan, callback)).toBe(true)
    expect(cooperativeBuild).toHaveBeenCalledWith(source, 1, plan, expect.any(Function))
    expect(FakeWorker.instances).toHaveLength(0)
    result.resolve(new Uint16Array([4, 5]))
    await Promise.resolve()
    expect(callback).toHaveBeenCalledWith(new Uint16Array([4, 5]))
  })

  it('uses cooperative work when the compatibility worker cannot be constructed', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('unavailable')
        }
      }
    )
    const source = volume()
    const plan = planTexture(source.dims, source.spacing)
    const result = deferred<Uint16Array | null>()
    const cooperativeBuild = vi.fn(() => result.promise)
    const builder = new WorkerFrameTextureBuilder(() => null, { cooperativeBuild })
    const callback = vi.fn()

    expect(builder.request(source, 1, plan, callback)).toBe(true)
    expect(cooperativeBuild).toHaveBeenCalledWith(source, 1, plan, expect.any(Function))
    result.resolve(new Uint16Array([6, 7]))
    await Promise.resolve()
    expect(callback).toHaveBeenCalledWith(new Uint16Array([6, 7]))
  })

  it('lets a newer large-frame target cancel cooperative work before starting the latest', async () => {
    const source = volume()
    const plan = planTexture(source.dims, source.spacing)
    const first = deferred<Uint16Array | null>()
    const latest = deferred<Uint16Array | null>()
    const cancelled: Array<() => boolean> = []
    const cooperativeBuild = vi.fn(
      (_volume: Volume, _frame: number, _plan: typeof plan, isCancelled: () => boolean) => {
        cancelled.push(isCancelled)
        return cancelled.length === 1 ? first.promise : latest.promise
      }
    )
    const builder = new WorkerFrameTextureBuilder(() => null, {
      maxWorkerCopyBytes: 1,
      cooperativeBuild
    })
    const obsolete = vi.fn()
    const current = vi.fn()

    builder.request(source, 1, plan, obsolete)
    builder.request(source, 2, plan, current)
    expect(cancelled[0]()).toBe(true)
    first.resolve(null)
    await Promise.resolve()
    expect(cooperativeBuild).toHaveBeenCalledTimes(2)
    latest.resolve(new Uint16Array([8, 9]))
    await Promise.resolve()

    expect(obsolete).toHaveBeenCalledWith(null)
    expect(current).toHaveBeenCalledWith(new Uint16Array([8, 9]))
  })

  it('reassigns an active target and drops a newer pending target when navigation returns', () => {
    vi.stubGlobal('Worker', FakeWorker)
    const source = volume()
    const plan = planTexture(source.dims, source.spacing)
    const builder = new WorkerFrameTextureBuilder()
    const supersededActive = vi.fn()
    const supersededPending = vi.fn()
    const current = vi.fn()

    builder.request(source, 1, plan, supersededActive)
    builder.request(source, 2, plan, supersededPending)
    builder.request(source, 1, plan, current)

    const worker = FakeWorker.instances[0]
    expect(worker.posted).toHaveLength(1)
    expect(Array.from(worker.posted[0].raw)).toEqual([3, 4])
    worker.respond({
      ok: true,
      token: worker.posted[0].token,
      data: new Uint16Array([7, 7])
    })

    expect(current).toHaveBeenCalledWith(new Uint16Array([7, 7]))
    expect(supersededActive).not.toHaveBeenCalled()
    expect(supersededPending).not.toHaveBeenCalled()
    expect(worker.posted).toHaveLength(1)
  })

  it('ignores a late error from a worker replaced by reset', () => {
    vi.stubGlobal('Worker', FakeWorker)
    const source = volume()
    const plan = planTexture(source.dims, source.spacing)
    const builder = new WorkerFrameTextureBuilder()
    const first = vi.fn()
    const second = vi.fn()

    builder.request(source, 1, plan, first)
    const oldWorker = FakeWorker.instances[0]
    const lateError = oldWorker.onerror
    builder.reset()
    builder.request(source, 2, plan, second)
    const currentWorker = FakeWorker.instances[1]
    lateError?.()
    currentWorker.respond({
      ok: true,
      token: currentWorker.posted[0].token,
      data: new Uint16Array([2, 2])
    })

    expect(second).toHaveBeenCalledWith(new Uint16Array([2, 2]))
    expect(currentWorker.terminate).not.toHaveBeenCalled()
  })
})
