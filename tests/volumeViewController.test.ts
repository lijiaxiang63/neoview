import { describe, expect, it, vi } from 'vitest'
import type { CameraBasis } from '../src/renderer/src/render3d/camera'
import {
  buildLabelTexData,
  planTexture,
  type TexPlan
} from '../src/renderer/src/render3d/normalize'
import type { RenderSchedulerCallbacks } from '../src/renderer/src/render3d/renderScheduler'
import type { Quality } from '../src/renderer/src/render3d/types'
import {
  WorkerFrameTextureBuilder,
  type FrameTextureBuilder
} from '../src/renderer/src/render3d/frameTextureClient'
import {
  LABEL_REBUILD_MS,
  VolumeViewController,
  type VolumeCamera,
  type VolumeRendererBackend,
  type VolumeRenderScheduler,
  type VolumeViewControllerDependencies,
  type VolumeViewState
} from '../src/renderer/src/render3d/volumeViewController'
import type { Region } from '../src/renderer/src/segmentation/regions'
import type { Volume } from '../src/renderer/src/volume/types'

const BASIS: CameraBasis = {
  eye: [1, 2, 3],
  right: [1, 0, 0],
  up: [0, 1, 0],
  fwd: [0, 0, -1]
}

class FakeRenderer implements VolumeRendererBackend {
  unsupportedReason: string | null = null
  onContextRestored: (() => void) | null = null
  readonly setVolume = vi.fn<VolumeRendererBackend['setVolume']>()
  readonly setFrameData = vi.fn<VolumeRendererBackend['setFrameData']>()
  readonly setWindow = vi.fn<VolumeRendererBackend['setWindow']>()
  readonly setMode = vi.fn<VolumeRendererBackend['setMode']>()
  readonly setDensity = vi.fn<VolumeRendererBackend['setDensity']>()
  readonly setBrightness = vi.fn<VolumeRendererBackend['setBrightness']>()
  readonly setCamera = vi.fn<VolumeRendererBackend['setCamera']>()
  readonly setLabelVolume = vi.fn<VolumeRendererBackend['setLabelVolume']>()
  readonly setLabelLut = vi.fn<VolumeRendererBackend['setLabelLut']>()
  readonly setLabelAlpha = vi.fn<VolumeRendererBackend['setLabelAlpha']>()
  readonly resize = vi.fn<VolumeRendererBackend['resize']>()
  readonly render = vi.fn<VolumeRendererBackend['render']>()
  readonly dispose = vi.fn<VolumeRendererBackend['dispose']>()
}

class FakeCamera implements VolumeCamera {
  readonly rotate = vi.fn<VolumeCamera['rotate']>()
  readonly dolly = vi.fn<VolumeCamera['dolly']>()
  readonly reset = vi.fn<VolumeCamera['reset']>()
  readonly basis = vi.fn(() => BASIS)
}

class FakeScheduler implements VolumeRenderScheduler {
  callbacks: RenderSchedulerCallbacks | null = null
  readonly sizes: Array<[number, number]> = []
  readonly requests: Quality[] = []
  readonly dragging: boolean[] = []
  readonly dispose = vi.fn(() => undefined)

  setSize(cssWidth: number, cssHeight: number): void {
    this.sizes.push([cssWidth, cssHeight])
  }

  request(quality: Quality): void {
    this.requests.push(quality)
  }

  setDragging(dragging: boolean): void {
    this.dragging.push(dragging)
  }
}

class ManualTimers {
  private nextHandle = 1
  readonly active = new Map<number, () => void>()
  readonly all = new Map<number, () => void>()
  readonly delays: number[] = []
  readonly cleared: number[] = []

  setTimeout = (callback: () => void, delay: number): number => {
    const handle = this.nextHandle++
    this.active.set(handle, callback)
    this.all.set(handle, callback)
    this.delays.push(delay)
    return handle
  }

  clearTimeout = (handle: number): void => {
    this.cleared.push(handle)
    this.active.delete(handle)
  }

  runActive(): void {
    const entry = this.active.entries().next().value as [number, () => void] | undefined
    if (!entry) throw new Error('expected an active timer')
    this.active.delete(entry[0])
    entry[1]()
  }
}

class ManualFrameTextureBuilder implements FrameTextureBuilder {
  readonly jobs: Array<{ frame: number; callback: (data: Uint16Array | null) => void }> = []
  readonly abandon = vi.fn()
  readonly reset = vi.fn()
  readonly dispose = vi.fn()

  request(
    _volume: Volume,
    frame: number,
    _plan: TexPlan,
    callback: (data: Uint16Array | null) => void
  ): boolean {
    this.jobs.push({ frame, callback })
    return true
  }
}

class UnavailableFrameTextureBuilder implements FrameTextureBuilder {
  readonly abandon = vi.fn()
  readonly reset = vi.fn()
  readonly dispose = vi.fn()

  request(): boolean {
    return false
  }
}

class ReowningManualFrameTextureBuilder implements FrameTextureBuilder {
  readonly requested: number[] = []
  active: { frame: number; callback: (data: Uint16Array | null) => void } | null = null
  pending: { frame: number; callback: (data: Uint16Array | null) => void } | null = null
  readonly abandon = vi.fn(() => {
    this.pending = null
    if (this.active) this.active.callback = () => undefined
  })
  readonly reset = vi.fn(() => {
    this.active = null
    this.pending = null
  })
  readonly dispose = vi.fn()

  request(
    _volume: Volume,
    frame: number,
    _plan: TexPlan,
    callback: (data: Uint16Array | null) => void
  ): boolean {
    this.requested.push(frame)
    if (this.active?.frame === frame) {
      this.active.callback = callback
      this.pending = null
    } else if (this.pending?.frame === frame) {
      this.pending.callback = callback
    } else if (this.active) {
      this.pending = { frame, callback }
    } else {
      this.active = { frame, callback }
    }
    return true
  }

  complete(data: Uint16Array): void {
    const job = this.active
    if (!job) throw new Error('expected an active frame build')
    this.active = this.pending
    this.pending = null
    job.callback(data)
  }
}

function makeVolume(name: string, dims: [number, number, number] = [2, 2, 2], frames = 3): Volume {
  const count = dims[0] * dims[1] * dims[2]
  const raw = new Uint8Array(count * frames)
  for (let frame = 0; frame < frames; frame++)
    raw.fill(frame * 40, frame * count, (frame + 1) * count)
  return {
    name,
    dims,
    frames,
    spacing: [1, 1, 1],
    datatypeCode: 2,
    datatypeName: 'uint8',
    raw,
    slope: 1,
    inter: 0,
    affine: new Float64Array(16),
    transformSource: 'spacing-fallback',
    suggestedRange: null,
    labels: null,
    stats: { dataMin: 0, dataMax: 100, p2: 0, p98: 100, typeRange: [0, 255] }
  }
}

function region(id = 1, visible = true, color = '#123456'): Region {
  return { id, visible, color, name: `Region ${id}`, voxelCount: 1, stats: null }
}

function state(volume: Volume, overrides: Partial<VolumeViewState> = {}): VolumeViewState {
  return {
    volume,
    frame: 0,
    range: { lo: 10, hi: 90 },
    renderMode: 'mip',
    density: 0.35,
    brightness: 0.45,
    labelMap: null,
    labelMapRev: 0,
    regions: [],
    regionOpacity: 0.5,
    ...overrides
  }
}

interface Harness {
  renderer: FakeRenderer
  camera: FakeCamera
  scheduler: FakeScheduler
  timers: ManualTimers
  controller: VolumeViewController
  initialTextureOf: ReturnType<typeof vi.fn>
  releaseInitialTexture: ReturnType<typeof vi.fn>
  buildTexture: ReturnType<typeof vi.fn>
  buildLabelTexture: ReturnType<typeof vi.fn>
  onUnsupported: ReturnType<typeof vi.fn>
}

function harness(
  options: {
    renderer?: FakeRenderer
    initial?: WeakMap<Volume, { data: Uint16Array; plan: TexPlan }>
    plan?: (dims: Volume['dims'], spacing: Volume['spacing']) => TexPlan
    frameBuilder?: FrameTextureBuilder
  } = {}
): Harness {
  const renderer = options.renderer ?? new FakeRenderer()
  const camera = new FakeCamera()
  const scheduler = new FakeScheduler()
  const timers = new ManualTimers()
  const initialTextureOf = vi.fn((volume: Volume) => options.initial?.get(volume) ?? null)
  const releaseInitialTexture = vi.fn((volume: Volume) => options.initial?.delete(volume))
  const buildTexture = vi.fn(
    (volume: Volume, frame: number, texturePlan: TexPlan, out?: Uint16Array) => {
      const count = texturePlan.texDims[0] * texturePlan.texDims[1] * texturePlan.texDims[2]
      const data = out && out.length === count ? out : new Uint16Array(count)
      data.fill(frame + 1)
      expect(volume.frames).toBeGreaterThan(frame)
      return data
    }
  )
  const buildLabelTexture = vi.fn(buildLabelTexData)
  const onUnsupported = vi.fn<(reason: string | null) => void>()
  const dependencies: Partial<VolumeViewControllerDependencies> = {
    createScheduler: (callbacks) => {
      scheduler.callbacks = callbacks
      return scheduler
    },
    timers,
    initialTextureOf,
    releaseInitialTexture,
    createFrameTextureBuilder: () => options.frameBuilder ?? new UnavailableFrameTextureBuilder(),
    planTexture: options.plan ?? ((dims, spacing) => planTexture(dims, spacing)),
    buildTexture,
    buildLabelTexture,
    onUnsupported
  }
  return {
    renderer,
    camera,
    scheduler,
    timers,
    controller: new VolumeViewController(renderer, camera, dependencies),
    initialTextureOf,
    releaseInitialTexture,
    buildTexture,
    buildLabelTexture,
    onUnsupported
  }
}

describe('VolumeViewController texture synchronization', () => {
  it('waits for an initially requested nonzero frame without building or rendering frame 0', () => {
    const volume = makeVolume('initial-target')
    const frameBuilder = new ManualFrameTextureBuilder()
    const h = harness({ frameBuilder })

    h.controller.updateState(state(volume, { frame: 2 }))

    expect(h.buildTexture).not.toHaveBeenCalled()
    expect(h.renderer.setVolume).not.toHaveBeenCalled()
    expect(frameBuilder.jobs.map((job) => job.frame)).toEqual([2])
    expect(h.scheduler.requests).toEqual([])
    h.scheduler.callbacks?.render('full')
    expect(h.renderer.render).not.toHaveBeenCalled()
    const lutUploads = h.renderer.setLabelLut.mock.calls.length
    h.renderer.onContextRestored?.()

    const target = new Uint16Array(8).fill(3)
    frameBuilder.jobs[0].callback(target)
    expect(h.renderer.setVolume).toHaveBeenCalledWith(target, expect.any(Array), expect.any(Array))
    expect(h.renderer.setFrameData).not.toHaveBeenCalled()
    expect(h.renderer.setLabelLut).toHaveBeenCalledTimes(lutUploads + 1)
    expect(h.scheduler.requests).toEqual(['full'])
  })

  it('releases and reuses the worker frame 0 payload on the first frame change', () => {
    const volume = makeVolume('first')
    const texturePlan = planTexture(volume.dims, volume.spacing)
    const workerData = new Uint16Array(8).fill(77)
    const initial = new WeakMap([[volume, { data: workerData, plan: texturePlan }]])
    const h = harness({ initial })

    h.controller.updateState(state(volume))
    expect(h.renderer.setVolume).toHaveBeenCalledWith(
      workerData,
      texturePlan.texDims,
      texturePlan.texSpacing
    )
    expect(h.buildTexture).not.toHaveBeenCalled()

    h.controller.updateState(state(volume, { frame: 1 }))
    const firstStaging = h.renderer.setFrameData.mock.calls.at(-1)?.[0]
    expect(h.releaseInitialTexture).toHaveBeenCalledWith(volume)
    expect(h.buildTexture).toHaveBeenLastCalledWith(volume, 1, texturePlan, workerData)
    h.controller.updateState(state(volume, { frame: 2 }))
    expect(h.buildTexture).toHaveBeenLastCalledWith(volume, 2, texturePlan, firstStaging)
    expect(Array.from(workerData)).toEqual(new Array(8).fill(3))

    h.controller.updateState({ ...state(volume), volume: null })
    h.controller.updateState(state(volume))
    expect(h.initialTextureOf).toHaveBeenCalledTimes(2)
    expect(h.buildTexture).toHaveBeenLastCalledWith(volume, 0, texturePlan)
  })

  it('builds frame 0 only when no worker payload exists and reuses staging thereafter', () => {
    const volume = makeVolume('fallback')
    const h = harness()
    h.controller.updateState(state(volume))
    expect(h.buildTexture).toHaveBeenCalledTimes(1)
    expect(h.buildTexture.mock.calls[0][1]).toBe(0)
    const initialStaging = h.renderer.setVolume.mock.calls[0][0]

    h.controller.updateState(state(volume, { frame: 2 }))
    expect(h.buildTexture).toHaveBeenLastCalledWith(volume, 2, expect.any(Object), initialStaging)
    expect(h.renderer.setFrameData).toHaveBeenCalledWith(initialStaging)
  })

  it('applies only the latest asynchronous frame result', () => {
    const volume = makeVolume('async')
    const texturePlan = planTexture(volume.dims, volume.spacing)
    const initial = new WeakMap([[volume, { data: new Uint16Array(8), plan: texturePlan }]])
    const frameBuilder = new ManualFrameTextureBuilder()
    const h = harness({ initial, frameBuilder })
    h.controller.updateState(state(volume))

    h.controller.updateState(state(volume, { frame: 1 }))
    h.controller.updateState(state(volume, { frame: 2 }))
    expect(frameBuilder.jobs.map((job) => job.frame)).toEqual([1, 2])
    expect(h.renderer.setFrameData).not.toHaveBeenCalled()

    frameBuilder.jobs[0].callback(new Uint16Array(8).fill(1))
    expect(h.renderer.setFrameData).not.toHaveBeenCalled()
    const latest = new Uint16Array(8).fill(2)
    frameBuilder.jobs[1].callback(latest)
    expect(h.renderer.setFrameData).toHaveBeenCalledWith(latest)
    expect(h.releaseInitialTexture).toHaveBeenCalledWith(volume)
    expect(h.buildTexture).not.toHaveBeenCalled()
    expect(h.scheduler.requests.at(-1)).toBe('interactive')
  })

  it('reuses the active frame build when the target sequence returns from 1 to 2 to 1', () => {
    const volume = makeVolume('return-active')
    const frameBuilder = new ReowningManualFrameTextureBuilder()
    const h = harness({ frameBuilder })
    h.controller.updateState(state(volume))

    h.controller.updateState(state(volume, { frame: 1 }))
    h.controller.updateState(state(volume, { frame: 2 }))
    h.controller.updateState(state(volume, { frame: 1 }))

    expect(frameBuilder.requested).toEqual([1, 2, 1])
    expect(frameBuilder.active?.frame).toBe(1)
    expect(frameBuilder.pending).toBeNull()
    const target = new Uint16Array(8).fill(8)
    frameBuilder.complete(target)
    expect(h.renderer.setFrameData).toHaveBeenCalledWith(target)
    expect(frameBuilder.active).toBeNull()
  })

  it('does not queue the same pending frame again for unrelated state changes', () => {
    const volume = makeVolume('same-pending')
    const frameBuilder = new ManualFrameTextureBuilder()
    const h = harness({ frameBuilder })
    h.controller.updateState(state(volume))
    h.controller.updateState(state(volume, { frame: 1 }))
    h.controller.updateState(state(volume, { frame: 1, range: { lo: 20, hi: 80 } }))
    h.controller.updateState(state(volume, { frame: 1, regions: [region()] }))

    expect(frameBuilder.jobs.map((job) => job.frame)).toEqual([1])
    const data = new Uint16Array(8).fill(9)
    frameBuilder.jobs[0].callback(data)
    expect(h.renderer.setFrameData).toHaveBeenCalledWith(data)
  })

  it('abandons callback ownership when the target returns to the applied frame', () => {
    const volume = makeVolume('return-applied')
    const frameBuilder = new ManualFrameTextureBuilder()
    const h = harness({ frameBuilder })
    h.controller.updateState(state(volume))
    const abandons = frameBuilder.abandon.mock.calls.length
    h.controller.updateState(state(volume, { frame: 1 }))
    h.controller.updateState(state(volume, { frame: 0 }))

    expect(frameBuilder.abandon).toHaveBeenCalledTimes(abandons + 1)
    frameBuilder.jobs[0].callback(new Uint16Array(8).fill(1))
    expect(h.renderer.setFrameData).not.toHaveBeenCalled()
  })

  it('reports an asynchronous frame failure without retrying it synchronously', () => {
    const volume = makeVolume('failed-frame')
    const texturePlan = planTexture(volume.dims, volume.spacing)
    const initial = new WeakMap([[volume, { data: new Uint16Array(8), plan: texturePlan }]])
    const frameBuilder = new ManualFrameTextureBuilder()
    const h = harness({ initial, frameBuilder })
    h.controller.updateState(state(volume))
    const builds = h.buildTexture.mock.calls.length

    h.controller.updateState(state(volume, { frame: 1 }))
    frameBuilder.jobs[0].callback(null)

    expect(h.buildTexture).toHaveBeenCalledTimes(builds)
    expect(h.renderer.setFrameData).not.toHaveBeenCalled()
    expect(h.onUnsupported).toHaveBeenLastCalledWith(
      'Could not prepare this frame for the 3D view.'
    )
    h.controller.updateState(state(volume, { frame: 0 }))
    expect(h.onUnsupported).toHaveBeenLastCalledWith(null)
  })

  it('redraws the applied frame after a failed target and context restoration', () => {
    const volume = makeVolume('failed-restoration')
    const texturePlan = planTexture(volume.dims, volume.spacing)
    const initial = new WeakMap([[volume, { data: new Uint16Array(8), plan: texturePlan }]])
    const frameBuilder = new ManualFrameTextureBuilder()
    const h = harness({ initial, frameBuilder })
    h.controller.updateState(state(volume))
    h.controller.updateState(state(volume, { frame: 1 }))
    frameBuilder.jobs[0].callback(null)
    const requestsAfterFailure = h.scheduler.requests.length

    h.renderer.onContextRestored?.()
    expect(h.scheduler.requests).toHaveLength(requestsAfterFailure)
    h.controller.updateState(state(volume, { frame: 0 }))

    expect(frameBuilder.abandon).toHaveBeenCalledTimes(1)
    expect(h.scheduler.requests).toHaveLength(requestsAfterFailure + 1)
    expect(h.scheduler.requests.at(-1)).toBe('full')
    expect(h.onUnsupported).toHaveBeenLastCalledWith(null)
  })

  it('keeps compatibility-worker construction failure off the synchronous texture path', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('unavailable')
        }
      }
    )
    try {
      const volume = makeVolume('worker-unavailable')
      const texturePlan = planTexture(volume.dims, volume.spacing)
      const initial = new WeakMap([[volume, { data: new Uint16Array(8), plan: texturePlan }]])
      let finish!: (data: Uint16Array | null) => void
      const cooperativeBuild = vi.fn(
        () =>
          new Promise<Uint16Array | null>((resolve) => {
            finish = resolve
          })
      )
      const frameBuilder = new WorkerFrameTextureBuilder(() => null, { cooperativeBuild })
      const h = harness({ initial, frameBuilder })
      h.controller.updateState(state(volume))
      const builds = h.buildTexture.mock.calls.length

      h.controller.updateState(state(volume, { frame: 1 }))
      expect(h.buildTexture).toHaveBeenCalledTimes(builds)
      finish(new Uint16Array(8).fill(4))
      await Promise.resolve()
      expect(h.renderer.setFrameData).toHaveBeenLastCalledWith(new Uint16Array(8).fill(4))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('resets the camera and replaces plan and staging on every volume switch', () => {
    const first = makeVolume('first')
    const second = makeVolume('second', [3, 2, 2])
    const h = harness()
    h.controller.updateState(state(first))
    h.controller.updateState(state(second))
    expect(h.camera.reset).toHaveBeenCalledTimes(2)
    expect(h.renderer.setVolume).toHaveBeenCalledTimes(2)
    expect(h.renderer.setVolume.mock.calls.at(-1)?.[1]).toEqual(second.dims)
  })

  it('keeps display and render setting changes uniform-only', () => {
    const volume = makeVolume('settings')
    const h = harness()
    const regions = [region()]
    h.controller.updateState(state(volume, { regions }))
    const volumeUploads = h.renderer.setVolume.mock.calls.length
    const textureBuilds = h.buildTexture.mock.calls.length
    const lutUpdates = h.renderer.setLabelLut.mock.calls.length

    h.controller.updateState(
      state(volume, {
        range: { lo: 20, hi: 80 },
        renderMode: 'composite',
        density: 0.7,
        brightness: 0.8,
        regions
      })
    )
    expect(h.renderer.setWindow).toHaveBeenLastCalledWith(0.2, 0.8)
    expect(h.renderer.setMode).toHaveBeenLastCalledWith('composite')
    expect(h.renderer.setDensity).toHaveBeenLastCalledWith(0.7)
    expect(h.renderer.setBrightness).toHaveBeenLastCalledWith(0.8)
    expect(h.renderer.setVolume).toHaveBeenCalledTimes(volumeUploads)
    expect(h.renderer.setFrameData).not.toHaveBeenCalled()
    expect(h.buildTexture).toHaveBeenCalledTimes(textureBuilds)
    expect(h.renderer.setLabelLut).toHaveBeenCalledTimes(lutUpdates)
    expect(h.scheduler.requests.at(-1)).toBe('interactive')
  })
})

describe('VolumeViewController region synchronization', () => {
  it('updates the LUT and opacity without rebuilding either texture', () => {
    const volume = makeVolume('regions')
    const h = harness()
    h.controller.updateState(state(volume, { regions: [region()] }))
    const baseUploads = h.renderer.setVolume.mock.calls.length
    const labelBuilds = h.buildLabelTexture.mock.calls.length

    h.controller.updateState(
      state(volume, { regions: [region(1, false, '#abcdef'), region(2)], regionOpacity: 0.8 })
    )
    const lut = h.renderer.setLabelLut.mock.calls.at(-1)?.[0]
    expect(Array.from(lut.slice(4, 8))).toEqual([0xab, 0xcd, 0xef, 0])
    expect(h.renderer.setLabelAlpha).toHaveBeenLastCalledWith(0.8)
    expect(h.renderer.setVolume).toHaveBeenCalledTimes(baseUploads)
    expect(h.buildLabelTexture).toHaveBeenCalledTimes(labelBuilds)
  })

  it('debounces label revisions and merges rapid updates into one rebuild', () => {
    const volume = makeVolume('labels')
    const labels = new Uint16Array(8)
    labels[7] = 1
    const h = harness()
    h.controller.updateState(state(volume, { labelMap: labels, regions: [region()] }))
    const firstTimer = [...h.timers.active.keys()][0]
    h.controller.updateState(
      state(volume, { labelMap: labels, labelMapRev: 1, regions: [region()] })
    )
    expect(h.timers.cleared).toContain(firstTimer)
    expect(h.timers.active.size).toBe(1)
    expect(h.timers.delays).toEqual([LABEL_REBUILD_MS, LABEL_REBUILD_MS])
    h.timers.all.get(firstTimer)?.()
    expect(h.timers.active.size).toBe(1)
    expect(h.buildLabelTexture).not.toHaveBeenCalled()
    h.timers.runActive()
    expect(h.buildLabelTexture).toHaveBeenCalledTimes(1)
    expect(h.renderer.setLabelVolume.mock.calls.at(-1)?.[0]).toBeInstanceOf(Uint8Array)
  })

  it('keeps full-resolution visibility in the LUT without rebuilding labels', () => {
    const volume = makeVolume('full-grid')
    const labels = new Uint16Array(8).fill(1)
    const h = harness()
    h.controller.updateState(state(volume, { labelMap: labels, regions: [region()] }))
    h.timers.runActive()
    const labelBuilds = h.buildLabelTexture.mock.calls.length

    h.controller.updateState(state(volume, { labelMap: labels, regions: [region(1, false)] }))
    expect(h.timers.active.size).toBe(0)
    expect(h.buildLabelTexture).toHaveBeenCalledTimes(labelBuilds)
    expect(h.renderer.setLabelLut.mock.calls.at(-1)?.[0][7]).toBe(0)
  })

  it('bakes strided visibility, preserves thin visible data, and clears when none remain visible', () => {
    const volume = makeVolume('strided-grid', [4, 4, 4])
    const labels = new Uint16Array(64)
    labels[63] = 1
    const stridedPlan: TexPlan = {
      stride: [2, 2, 2],
      texDims: [2, 2, 2],
      texSpacing: [2, 2, 2]
    }
    const h = harness({ plan: () => stridedPlan })
    h.controller.updateState(state(volume, { labelMap: labels, regions: [region()] }))
    h.timers.runActive()
    const visibleTexture = h.renderer.setLabelVolume.mock.calls.at(-1)?.[0]
    expect(visibleTexture?.[7]).toBe(1)

    h.controller.updateState(state(volume, { labelMap: labels, regions: [region(1, false)] }))
    expect(h.timers.active.size).toBe(1)
    h.timers.runActive()
    expect(h.renderer.setLabelVolume).toHaveBeenLastCalledWith(null)
  })

  it('clears immediately after region removal', () => {
    const volume = makeVolume('clear')
    const labels = new Uint16Array(8).fill(1)
    const h = harness()
    h.controller.updateState(state(volume, { labelMap: labels, regions: [region()] }))
    h.timers.runActive()
    h.controller.updateState(state(volume, { labelMap: labels, regions: [] }))
    expect(h.renderer.setLabelVolume).toHaveBeenLastCalledWith(null)
    expect(h.scheduler.requests.at(-1)).toBe('full')
  })

  it('invalidates an old volume label callback', () => {
    const first = makeVolume('first')
    const second = makeVolume('second')
    const labels = new Uint16Array(8).fill(1)
    const h = harness()
    h.controller.updateState(state(first, { labelMap: labels, regions: [region()] }))
    const oldCallback = [...h.timers.all.values()][0]
    h.controller.updateState(state(second))
    const callsAfterSwitch = h.renderer.setLabelVolume.mock.calls.length
    oldCallback()
    expect(h.renderer.setLabelVolume).toHaveBeenCalledTimes(callsAfterSwitch)
    expect(h.buildLabelTexture).not.toHaveBeenCalled()
  })
})

describe('VolumeViewController lifecycle and restoration', () => {
  it('restores the latest frame, settings, camera, region state, and full render request', () => {
    const volume = makeVolume('restore')
    const labels = new Uint16Array(8).fill(1)
    const h = harness()
    h.controller.updateState(state(volume, { labelMap: labels, regions: [region()] }))
    h.timers.runActive()
    h.controller.updateState(
      state(volume, {
        frame: 2,
        range: { lo: 20, hi: 80 },
        renderMode: 'composite',
        density: 0.75,
        brightness: 0.9,
        labelMap: labels,
        regions: [region(1, true, '#abcdef')],
        regionOpacity: 0.7
      })
    )
    const currentFrame = h.renderer.setFrameData.mock.calls.at(-1)?.[0]
    const labelBuilds = h.buildLabelTexture.mock.calls.length

    h.renderer.onContextRestored?.()
    expect(h.renderer.setVolume).toHaveBeenLastCalledWith(
      currentFrame,
      expect.any(Array),
      expect.any(Array)
    )
    expect(h.renderer.setWindow).toHaveBeenLastCalledWith(0.2, 0.8)
    expect(h.renderer.setMode).toHaveBeenLastCalledWith('composite')
    expect(h.renderer.setDensity).toHaveBeenLastCalledWith(0.75)
    expect(h.renderer.setBrightness).toHaveBeenLastCalledWith(0.9)
    expect(h.renderer.setLabelAlpha).toHaveBeenLastCalledWith(0.7)
    expect(h.buildLabelTexture).toHaveBeenCalledTimes(labelBuilds)
    expect(h.renderer.setLabelVolume.mock.calls.at(-1)?.[0]).toBeInstanceOf(Uint8Array)
    expect(h.renderer.setCamera).toHaveBeenLastCalledWith(BASIS, expect.any(Number))
    expect(h.scheduler.requests.at(-1)).toBe('full')
  })

  it('rebuilds current label data on restore only when a debounce is pending', () => {
    const volume = makeVolume('restore-pending')
    const labels = new Uint16Array(8).fill(1)
    const h = harness()
    h.controller.updateState(state(volume, { labelMap: labels, regions: [region()] }))
    const lateTimer = [...h.timers.all.values()][0]

    h.renderer.onContextRestored?.()
    expect(h.timers.active.size).toBe(0)
    expect(h.buildLabelTexture).toHaveBeenCalledTimes(1)
    expect(h.renderer.setLabelVolume.mock.calls.at(-1)?.[0]).toBeInstanceOf(Uint8Array)
    lateTimer()
    expect(h.buildLabelTexture).toHaveBeenCalledTimes(1)
  })

  it('reports unsupported changes and suppresses render requests while unsupported', () => {
    const renderer = new FakeRenderer()
    renderer.unsupportedReason = 'Unavailable.'
    const h = harness({ renderer })
    expect(h.onUnsupported).toHaveBeenCalledWith('Unavailable.')
    h.controller.updateState(state(makeVolume('unsupported')))
    expect(h.scheduler.requests).toEqual([])

    renderer.unsupportedReason = null
    renderer.onContextRestored?.()
    expect(h.onUnsupported).toHaveBeenLastCalledWith(null)
    expect(h.scheduler.requests.at(-1)).toBe('full')
  })

  it('routes camera interaction through the scheduler', () => {
    const h = harness()
    h.controller.setSize(200, 100)
    h.controller.setDragging(true)
    h.controller.rotate(4, -3)
    h.controller.dolly(20)
    h.controller.setDragging(false)
    h.controller.resetCamera()
    expect(h.scheduler.sizes).toEqual([[200, 100]])
    expect(h.scheduler.dragging).toEqual([true, false])
    expect(h.camera.rotate).toHaveBeenCalledWith(4, -3)
    expect(h.camera.dolly).toHaveBeenCalledWith(20)
    expect(h.scheduler.requests).toEqual(['interactive', 'interactive', 'full'])
  })

  it('maps the camera through the current volume affine after replacement', () => {
    const first = makeVolume('first-camera')
    first.affine = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    const second = makeVolume('second-camera')
    second.affine = new Float64Array([-1, 0, 0, 0, 0, 0, 1, -293, 0, -1, 0, 0, 0, 0, 0, 1])
    const h = harness()

    h.controller.updateState(state(first))
    h.scheduler.callbacks?.render('full')
    expect(h.renderer.setCamera).toHaveBeenLastCalledWith(BASIS, expect.any(Number))

    h.controller.updateState(state(second))
    h.scheduler.callbacks?.render('full')
    const expected: CameraBasis = {
      eye: [-1, -3, 2],
      right: [-1, 0, 0],
      up: [0, 0, 1],
      fwd: [0, 1, 0]
    }
    expect(h.renderer.setCamera).toHaveBeenLastCalledWith(expected, expect.any(Number))

    h.renderer.setCamera.mockClear()
    h.renderer.onContextRestored?.()
    expect(h.renderer.setCamera).toHaveBeenCalledWith(expected, expect.any(Number))
  })

  it('disposes once and makes pending label and context callbacks no-ops', () => {
    const volume = makeVolume('dispose')
    const labels = new Uint16Array(8).fill(1)
    const h = harness()
    h.controller.updateState(state(volume, { labelMap: labels, regions: [region()] }))
    const lateLabel = [...h.timers.all.values()][0]
    const lateRestore = h.renderer.onContextRestored
    const callsBefore = h.renderer.setLabelVolume.mock.calls.length

    h.controller.dispose()
    h.controller.dispose()
    lateLabel()
    lateRestore?.()
    h.controller.rotate(1, 1)
    expect(h.scheduler.dispose).toHaveBeenCalledTimes(1)
    expect(h.renderer.dispose).toHaveBeenCalledTimes(1)
    expect(h.renderer.onContextRestored).toBeNull()
    expect(h.renderer.setLabelVolume).toHaveBeenCalledTimes(callsBefore)
    expect(h.buildLabelTexture).not.toHaveBeenCalled()
  })
})
