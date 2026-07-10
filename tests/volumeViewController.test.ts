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
  buildTexture: ReturnType<typeof vi.fn>
  buildLabelTexture: ReturnType<typeof vi.fn>
  onUnsupported: ReturnType<typeof vi.fn>
}

function harness(
  options: {
    renderer?: FakeRenderer
    initial?: WeakMap<Volume, { data: Uint16Array; plan: TexPlan }>
    plan?: (dims: Volume['dims'], spacing: Volume['spacing']) => TexPlan
  } = {}
): Harness {
  const renderer = options.renderer ?? new FakeRenderer()
  const camera = new FakeCamera()
  const scheduler = new FakeScheduler()
  const timers = new ManualTimers()
  const initialTextureOf = vi.fn((volume: Volume) => options.initial?.get(volume) ?? null)
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
    buildTexture,
    buildLabelTexture,
    onUnsupported
  }
}

describe('VolumeViewController texture synchronization', () => {
  it('reuses the non-consuming worker frame 0 payload and preserves it across frame changes', () => {
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
    expect(h.buildTexture).toHaveBeenLastCalledWith(volume, 1, texturePlan, undefined)
    h.controller.updateState(state(volume, { frame: 2 }))
    expect(h.buildTexture).toHaveBeenLastCalledWith(volume, 2, texturePlan, firstStaging)
    expect(Array.from(workerData)).toEqual(new Array(8).fill(77))

    h.controller.updateState({ ...state(volume), volume: null })
    h.controller.updateState(state(volume))
    expect(h.initialTextureOf).toHaveBeenCalledTimes(2)
    expect(h.renderer.setVolume).toHaveBeenLastCalledWith(
      workerData,
      texturePlan.texDims,
      texturePlan.texSpacing
    )
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
