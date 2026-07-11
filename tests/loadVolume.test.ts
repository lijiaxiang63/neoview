import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  frameTextureSourceOf,
  initialTexOf,
  loadVolume,
  releaseFrameTextureSource
} from '../src/renderer/src/volume/loadVolume'
import type {
  LoadRequest,
  LoadResponse,
  RetainedFrameRequest,
  RetainedFrameResponse
} from '../src/renderer/src/volume/worker'
import { planTexture } from '../src/renderer/src/render3d/normalize'
import type { Volume } from '../src/renderer/src/volume/types'

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent<LoadResponse | RetainedFrameResponse>) => void) | null = null
  onerror: (() => void) | null = null
  readonly posted: Array<{
    message: LoadRequest | RetainedFrameRequest
    transfer: Transferable[]
  }> = []
  readonly terminate = vi.fn()

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(message: LoadRequest | RetainedFrameRequest, transfer: Transferable[] = []): void {
    this.posted.push({ message, transfer })
  }

  respond(response: LoadResponse | RetainedFrameResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<LoadResponse | RetainedFrameResponse>)
  }
}

function volume(name = 'base.nii'): Volume {
  return {
    name,
    dims: [1, 1, 1],
    frames: 1,
    spacing: [1, 1, 1],
    datatypeCode: 2,
    datatypeName: 'uint8',
    raw: new Uint8Array([1]),
    slope: 1,
    inter: 0,
    affine: new Float64Array(16),
    transformSource: 'spacing-fallback',
    suggestedRange: null,
    labels: null,
    stats: { dataMin: 1, dataMax: 1, p2: 1, p98: 1, typeRange: [0, 255] }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeWorker.instances.length = 0
})

describe('volume load worker ownership', () => {
  it('rejects a pre-cancelled load without creating a worker', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const abort = new AbortController()
    abort.abort()

    await expect(
      loadVolume('base.nii', new ArrayBuffer(8), { signal: abort.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it('terminates an active worker on cancellation and ignores its late response', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const abort = new AbortController()
    const pending = loadVolume('base.nii', new ArrayBuffer(8), { signal: abort.signal })
    const worker = FakeWorker.instances[0]
    const lateResponse = worker.onmessage

    abort.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(worker.onmessage).toBeNull()
    expect(worker.onerror).toBeNull()

    lateResponse?.({
      data: { ok: true, volume: volume('late.nii'), tex: null }
    } as MessageEvent<LoadResponse>)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('removes cancellation ownership after a successful response', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const abort = new AbortController()
    const input = new ArrayBuffer(8)
    const loaded = volume()
    const pending = loadVolume('base.nii', input, { skipTex: true, signal: abort.signal })
    const worker = FakeWorker.instances[0]

    expect(worker.posted).toEqual([
      { message: { name: 'base.nii', bytes: input, skipTex: true }, transfer: [input] }
    ])
    worker.respond({ ok: true, volume: loaded, tex: null })
    await expect(pending).resolves.toBe(loaded)
    expect(initialTexOf(loaded)).toBeNull()
    expect(worker.terminate).toHaveBeenCalledTimes(1)

    abort.abort()
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('retains a shared frame source and later sends only frame and plan tokens', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const loaded = volume()
    loaded.frames = 2
    const input = new ArrayBuffer(8)
    const pending = loadVolume('base.nii', input)
    const worker = FakeWorker.instances[0]
    worker.respond({ ok: true, volume: loaded, tex: null, frameSource: true })
    await expect(pending).resolves.toBe(loaded)
    expect(worker.terminate).not.toHaveBeenCalled()

    const source = frameTextureSourceOf(loaded)
    expect(source).not.toBeNull()
    const callback = vi.fn()
    const plan = planTexture(loaded.dims, loaded.spacing)
    const requestId = source!.request(1, plan, callback)
    expect(worker.posted.at(-1)).toEqual({
      message: { kind: 'frame', token: requestId, frame: 1, plan },
      transfer: []
    })
    worker.respond({
      kind: 'frame',
      ok: true,
      token: requestId!,
      data: new Uint16Array([9])
    })
    expect(callback).toHaveBeenCalledWith(new Uint16Array([9]))

    releaseFrameTextureSource(loaded)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(frameTextureSourceOf(loaded)).toBeNull()
  })
})
