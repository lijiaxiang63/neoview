import { OrbitCamera, FOV_Y_RAD, type CameraBasis } from './camera'
import {
  buildLabelTexData,
  buildTexData,
  planTexture,
  scaledToNormalized,
  type TexPlan
} from './normalize'
import { Raycaster } from './raycaster'
import { createBrowserRenderScheduler, type RenderSchedulerCallbacks } from './renderScheduler'
import type { Quality, RenderMode } from './types'
import { WorkerFrameTextureBuilder, type FrameTextureBuilder } from './frameTextureClient'
import { colorComponents, type Region } from '../segmentation/regions'
import { initialTexOf, releaseInitialTex } from '../volume/loadVolume'
import type { Volume } from '../volume/types'

export const LABEL_REBUILD_MS = 200
export const LABEL_PALETTE_MAX = 255

export interface VolumeRendererBackend {
  unsupportedReason: string | null
  onContextRestored: (() => void) | null
  setVolume(
    data: Uint16Array,
    dims: [number, number, number],
    spacing: [number, number, number]
  ): void
  setFrameData(data: Uint16Array): void
  setWindow(lo: number, hi: number): void
  setMode(mode: RenderMode): void
  setDensity(density: number): void
  setBrightness(brightness: number): void
  setCamera(basis: CameraBasis, fovYRad: number): void
  setLabelVolume(data: Uint8Array | null): void
  setLabelLut(rgba: Uint8Array): void
  setLabelAlpha(alpha: number): void
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void
  render(quality: Quality): void
  dispose(): void
}

export interface VolumeCamera {
  rotate(dx: number, dy: number): void
  dolly(deltaY: number): void
  reset(): void
  basis(): CameraBasis
}

export interface VolumeRenderScheduler {
  setSize(cssWidth: number, cssHeight: number): void
  request(quality: Quality): void
  setDragging(dragging: boolean): void
  dispose(): void
}

export interface VolumeViewState {
  volume: Volume | null
  frame: number
  range: { lo: number; hi: number }
  renderMode: RenderMode
  density: number
  brightness: number
  labelMap: Uint16Array | null
  labelMapRev: number
  regions: readonly Region[]
  regionOpacity: number
}

interface InitialTexture {
  data: Uint16Array
  plan: TexPlan
}

export interface VolumeViewControllerDependencies {
  createScheduler(callbacks: RenderSchedulerCallbacks): VolumeRenderScheduler
  timers: {
    setTimeout(callback: () => void, delay: number): number
    clearTimeout(handle: number): void
  }
  initialTextureOf(volume: Volume): InitialTexture | null
  releaseInitialTexture(volume: Volume): void
  createFrameTextureBuilder(): FrameTextureBuilder
  planTexture(dims: Volume['dims'], spacing: Volume['spacing']): TexPlan
  buildTexture(volume: Volume, frame: number, plan: TexPlan, out?: Uint16Array): Uint16Array
  buildLabelTexture(
    labelMap: Uint16Array,
    dims: Volume['dims'],
    plan: TexPlan,
    indexOf: Uint8Array,
    out?: Uint8Array
  ): Uint8Array
  onUnsupported(reason: string | null): void
}

const browserDependencies: VolumeViewControllerDependencies = {
  createScheduler: createBrowserRenderScheduler,
  timers: {
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (handle) => window.clearTimeout(handle)
  },
  initialTextureOf: initialTexOf,
  releaseInitialTexture: releaseInitialTex,
  createFrameTextureBuilder: () => new WorkerFrameTextureBuilder(),
  planTexture,
  buildTexture: buildTexData,
  buildLabelTexture: buildLabelTexData,
  onUnsupported: () => undefined
}

const EMPTY_STATE: VolumeViewState = {
  volume: null,
  frame: 0,
  range: { lo: 0, hi: 1 },
  renderMode: 'mip',
  density: 0.35,
  brightness: 0.45,
  labelMap: null,
  labelMapRev: 0,
  regions: [],
  regionOpacity: 0.5
}

/** Owns one 3D renderer, its camera, scheduling, and all non-React state sync. */
export class VolumeViewController {
  private readonly renderer: VolumeRendererBackend
  private readonly camera: VolumeCamera
  private readonly dependencies: VolumeViewControllerDependencies
  private readonly scheduler: VolumeRenderScheduler
  private readonly frameTextureBuilder: FrameTextureBuilder
  private state = EMPTY_STATE
  private plan: TexPlan | null = null
  private staging: Uint16Array | null = null
  private stagingIsWorkerInitial = false
  private volumeTexturePresent = false
  /** A target frame is still being built, so no earlier frame may render. */
  private frameRenderBlocked = false
  private appliedFrame = 0
  private labelStaging: Uint8Array | null = null
  private labelTexturePresent = false
  private labelDirty = false
  private labelTimer: number | null = null
  private labelGeneration = 0
  private frameGeneration = 0
  /** Latest frame requested from the async builder but not yet applied. */
  private requestedFrame: number | null = null
  private frameFailure: string | null = null
  private paletteKey = ''
  private labelKey = ''
  private lastUnsupported: string | null | undefined
  private disposed = false

  constructor(
    renderer: VolumeRendererBackend,
    camera: VolumeCamera,
    dependencies: Partial<VolumeViewControllerDependencies> = {}
  ) {
    this.renderer = renderer
    this.camera = camera
    this.dependencies = {
      ...browserDependencies,
      ...dependencies,
      timers: dependencies.timers ?? browserDependencies.timers
    }
    this.scheduler = this.dependencies.createScheduler({
      resize: (cssWidth, cssHeight, devicePixelRatio) =>
        this.renderer.resize(cssWidth, cssHeight, devicePixelRatio),
      render: (quality) => {
        if (this.disposed || this.frameRenderBlocked) return
        this.applyCamera()
        this.renderer.render(quality)
      }
    })
    this.frameTextureBuilder = this.dependencies.createFrameTextureBuilder()
    this.renderer.onContextRestored = this.handleContextRestored
    this.reportUnsupported()
  }

  updateState(next: VolumeViewState): void {
    if (this.disposed) return
    const previous = this.state
    const volumeChanged = previous.volume !== next.volume
    const rangeChanged = previous.range.lo !== next.range.lo || previous.range.hi !== next.range.hi
    const settingsChanged =
      previous.renderMode !== next.renderMode ||
      previous.density !== next.density ||
      previous.brightness !== next.brightness
    const opacityChanged = previous.regionOpacity !== next.regionOpacity
    const regionsChanged = previous.regions !== next.regions
    let paletteChanged = volumeChanged
    let membershipChanged = volumeChanged
    this.state = next

    let requestFull = false
    let requestInteractive = false

    if (volumeChanged) {
      this.replaceVolume()
      requestFull = next.volume !== null && this.volumeTexturePresent
    }

    if (next.volume && this.plan) {
      if (this.volumeTexturePresent && this.appliedFrame === next.frame) {
        const needsRestoredFrame = this.frameRenderBlocked || this.frameFailure !== null
        if (this.requestedFrame !== null) this.abandonFrameRequest()
        this.frameRenderBlocked = false
        this.frameFailure = null
        if (needsRestoredFrame) requestFull = true
      } else if (this.staging && this.appliedFrame === next.frame) {
        if (this.requestedFrame !== null) this.abandonFrameRequest()
        this.installFirstFrame(this.staging, this.plan)
        this.frameRenderBlocked = false
        this.frameFailure = null
        requestFull = true
      } else if (this.requestedFrame !== next.frame) {
        const appliedSynchronously = this.queueFrame(next.frame)
        if (appliedSynchronously) {
          if (volumeChanged) requestFull = true
          else requestInteractive = true
        }
      }
    }

    if (next.volume && (volumeChanged || rangeChanged || settingsChanged)) {
      this.applyDisplayState()
      requestInteractive = requestInteractive || !volumeChanged
    }

    if (volumeChanged || regionsChanged) {
      const nextPaletteKey = paletteSignature(next.regions)
      const nextLabelKey = labelSignature(next.regions, this.plan)
      paletteChanged = paletteChanged || this.paletteKey !== nextPaletteKey
      membershipChanged = membershipChanged || this.labelKey !== nextLabelKey
      this.paletteKey = nextPaletteKey
      this.labelKey = nextLabelKey
    }

    if (next.volume && paletteChanged) {
      this.applyRegionLut()
      requestInteractive = requestInteractive || !volumeChanged
    }

    if (next.volume && (volumeChanged || opacityChanged)) {
      this.renderer.setLabelAlpha(next.regionOpacity)
      requestInteractive = requestInteractive || !volumeChanged
    }

    const labelChanged =
      volumeChanged ||
      previous.labelMap !== next.labelMap ||
      previous.labelMapRev !== next.labelMapRev ||
      membershipChanged
    if (labelChanged && this.queueLabelRebuild()) requestFull = true

    this.reportUnsupported()
    if (requestFull) this.request('full')
    else if (requestInteractive) this.request('interactive')
  }

  setSize(cssWidth: number, cssHeight: number): void {
    if (!this.disposed) this.scheduler.setSize(cssWidth, cssHeight)
  }

  setDragging(dragging: boolean): void {
    if (!this.disposed) this.scheduler.setDragging(dragging)
  }

  rotate(dx: number, dy: number): void {
    if (this.disposed) return
    this.camera.rotate(dx, dy)
    this.request('interactive')
  }

  dolly(deltaY: number): void {
    if (this.disposed) return
    this.camera.dolly(deltaY)
    this.request('interactive')
  }

  resetCamera(): void {
    if (this.disposed) return
    this.camera.reset()
    this.request('full')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelLabelTimer()
    this.frameGeneration++
    this.requestedFrame = null
    this.frameTextureBuilder.dispose()
    this.scheduler.dispose()
    this.renderer.onContextRestored = null
    this.renderer.dispose()
    this.plan = null
    this.staging = null
    this.volumeTexturePresent = false
    this.frameRenderBlocked = false
    this.frameFailure = null
    this.labelStaging = null
  }

  private replaceVolume(): void {
    this.cancelLabelTimer()
    this.frameGeneration++
    this.frameTextureBuilder.reset()
    this.plan = null
    this.staging = null
    this.volumeTexturePresent = false
    this.frameRenderBlocked = false
    this.frameFailure = null
    this.labelStaging = null
    this.labelTexturePresent = false
    this.labelDirty = false
    this.appliedFrame = -1
    this.requestedFrame = null
    this.stagingIsWorkerInitial = false
    const volume = this.state.volume
    if (!volume) {
      this.renderer.setLabelVolume(null)
      return
    }
    const initial = this.dependencies.initialTextureOf(volume)
    this.plan = initial?.plan ?? this.dependencies.planTexture(volume.dims, volume.spacing)
    if (initial) {
      this.staging = initial.data
      this.stagingIsWorkerInitial = true
      this.appliedFrame = 0
    } else if (this.state.frame === 0) {
      this.staging = this.dependencies.buildTexture(volume, 0, this.plan)
      this.appliedFrame = 0
    }
    if (this.state.frame === 0 && this.staging) {
      this.renderer.setVolume(this.staging, this.plan.texDims, this.plan.texSpacing)
      this.volumeTexturePresent = true
    } else {
      // Do not flash or upload frame 0 when the first observed state already
      // targets another frame. A late scheduled render is blocked as well.
      this.frameRenderBlocked = true
    }
    this.camera.reset()
  }

  /** Queue an off-thread frame build. Returns true only when the synchronous
   * fallback had to apply immediately. */
  private queueFrame(frame: number): boolean {
    const volume = this.state.volume
    const plan = this.plan
    if (!volume || !plan) return false
    const generation = ++this.frameGeneration
    this.requestedFrame = frame
    const posted = this.frameTextureBuilder.request(volume, frame, plan, (data) => {
      if (
        this.disposed ||
        generation !== this.frameGeneration ||
        this.state.volume !== volume ||
        this.state.frame !== frame ||
        this.plan !== plan
      ) {
        return
      }
      const needsFullRender = this.frameRenderBlocked || !this.volumeTexturePresent
      if (data) {
        this.applyBuiltFrame(volume, frame, plan, data)
      } else {
        // An accepted asynchronous build may represent a very large frame.
        // Retrying that work synchronously would recreate the UI stall (and
        // often the same allocation failure) the builder was introduced to
        // avoid. Keep the prior texture and surface a recoverable 3D error.
        this.frameRenderBlocked = true
        this.frameFailure = 'Could not prepare this frame for the 3D view.'
        this.reportUnsupported()
        return
      }
      this.requestedFrame = null
      this.frameFailure = null
      this.reportUnsupported()
      this.request(needsFullRender ? 'full' : 'interactive')
    })
    if (posted) return false
    this.requestedFrame = null
    this.applyFrameSync(frame)
    return true
  }

  private applyFrameSync(frame: number): void {
    const volume = this.state.volume
    const plan = this.plan
    if (!volume || !plan) return
    this.releaseWorkerInitial(volume)
    const reusable = this.staging ?? undefined
    this.staging = this.dependencies.buildTexture(volume, frame, plan, reusable)
    this.frameFailure = null
    this.appliedFrame = frame
    if (this.volumeTexturePresent) {
      this.renderer.setFrameData(this.staging)
    } else {
      this.installFirstFrame(this.staging, plan)
    }
    this.frameRenderBlocked = false
  }

  private applyBuiltFrame(volume: Volume, frame: number, plan: TexPlan, data: Uint16Array): void {
    this.releaseWorkerInitial(volume)
    this.staging = data
    this.frameFailure = null
    this.appliedFrame = frame
    if (this.volumeTexturePresent) {
      this.renderer.setFrameData(data)
    } else {
      this.installFirstFrame(data, plan)
    }
    this.frameRenderBlocked = false
  }

  private installFirstFrame(data: Uint16Array, plan: TexPlan): void {
    this.renderer.setVolume(data, plan.texDims, plan.texSpacing)
    this.volumeTexturePresent = true
    // These calls are cheap state assignments in the backend and make a frame
    // that completes after context restoration self-sufficient.
    this.applyDisplayState()
    this.applyRegionLut()
    this.renderer.setLabelAlpha(this.state.regionOpacity)
    if (!this.labelDirty) {
      if (this.labelTexturePresent && this.labelStaging) {
        this.renderer.setLabelVolume(this.labelStaging)
      } else {
        this.renderer.setLabelVolume(null)
      }
    }
  }

  private abandonFrameRequest(): void {
    this.frameGeneration++
    this.requestedFrame = null
    this.frameTextureBuilder.abandon()
  }

  private releaseWorkerInitial(volume: Volume): void {
    if (!this.stagingIsWorkerInitial) return
    this.dependencies.releaseInitialTexture(volume)
    this.stagingIsWorkerInitial = false
  }

  private applyDisplayState(): void {
    const volume = this.state.volume
    if (!volume) return
    this.renderer.setWindow(
      scaledToNormalized(volume, this.state.range.lo),
      scaledToNormalized(volume, this.state.range.hi)
    )
    this.renderer.setMode(this.state.renderMode)
    this.renderer.setDensity(this.state.density)
    this.renderer.setBrightness(this.state.brightness)
  }

  private applyRegionLut(): void {
    const lut = new Uint8Array(256 * 4)
    this.state.regions.slice(0, LABEL_PALETTE_MAX).forEach((region, index) => {
      const [red, green, blue] = colorComponents(region.color)
      const offset = (index + 1) * 4
      lut[offset] = red
      lut[offset + 1] = green
      lut[offset + 2] = blue
      lut[offset + 3] = region.visible ? 255 : 0
    })
    this.renderer.setLabelLut(lut)
  }

  /** Returns true when an existing texture was cleared immediately. */
  private queueLabelRebuild(): boolean {
    this.cancelLabelTimer()
    const { volume, labelMap, regions } = this.state
    if (!volume || !this.plan || !labelMap || regions.length === 0) {
      const changed = this.labelTexturePresent
      this.renderer.setLabelVolume(null)
      this.labelTexturePresent = false
      this.labelDirty = false
      return changed
    }
    this.labelDirty = true
    const generation = this.labelGeneration
    this.labelTimer = this.dependencies.timers.setTimeout(() => {
      if (this.disposed || generation !== this.labelGeneration) return
      this.labelTimer = null
      this.rebuildLabelTexture(generation)
      if (!this.disposed && generation === this.labelGeneration) this.request('full')
    }, LABEL_REBUILD_MS)
    return false
  }

  private rebuildLabelTexture(generation = this.labelGeneration): void {
    const { volume, labelMap, regions } = this.state
    const plan = this.plan
    if (!volume || !plan || !labelMap || this.disposed) return
    const paletteRegions = regions.slice(0, LABEL_PALETTE_MAX)
    const maxId = paletteRegions.reduce((maximum, region) => Math.max(maximum, region.id), 0)
    const indexOf = new Uint8Array(maxId + 1)
    const bakeVisibility = plan.stride.some((value) => value > 1)
    let mapped = 0
    paletteRegions.forEach((region, index) => {
      if (!bakeVisibility || region.visible) {
        indexOf[region.id] = index + 1
        mapped++
      }
    })
    if (mapped === 0) {
      this.renderer.setLabelVolume(null)
      this.labelTexturePresent = false
      this.labelDirty = false
      return
    }
    const data = this.dependencies.buildLabelTexture(
      labelMap,
      volume.dims,
      plan,
      indexOf,
      this.labelStaging ?? undefined
    )
    if (
      this.disposed ||
      generation !== this.labelGeneration ||
      this.state.volume !== volume ||
      this.state.labelMap !== labelMap ||
      this.plan !== plan
    ) {
      return
    }
    this.labelStaging = data
    this.renderer.setLabelVolume(data)
    this.reportUnsupported()
    this.labelTexturePresent = this.renderer.unsupportedReason === null
    this.labelDirty = false
  }

  private cancelLabelTimer(): void {
    this.labelGeneration++
    if (this.labelTimer !== null) this.dependencies.timers.clearTimeout(this.labelTimer)
    this.labelTimer = null
  }

  private applyCamera(): void {
    this.renderer.setCamera(this.camera.basis(), FOV_Y_RAD)
  }

  private readonly handleContextRestored = (): void => {
    if (this.disposed) return
    const volume = this.state.volume
    if (volume && this.plan && this.staging && this.volumeTexturePresent) {
      this.renderer.setVolume(this.staging, this.plan.texDims, this.plan.texSpacing)
      this.applyDisplayState()
      this.applyRegionLut()
      this.renderer.setLabelAlpha(this.state.regionOpacity)
      this.cancelLabelTimer()
      if (this.labelDirty) this.rebuildLabelTexture()
      else if (this.labelTexturePresent && this.labelStaging) {
        this.renderer.setLabelVolume(this.labelStaging)
      } else this.renderer.setLabelVolume(null)
      this.applyCamera()
    }
    this.reportUnsupported()
    this.request('full')
  }

  private request(quality: Quality): void {
    if (!this.disposed && !this.frameRenderBlocked && !this.renderer.unsupportedReason) {
      this.scheduler.request(quality)
    }
  }

  private reportUnsupported(): void {
    const reason = this.frameFailure ?? this.renderer.unsupportedReason
    if (reason === this.lastUnsupported) return
    this.lastUnsupported = reason
    this.dependencies.onUnsupported(reason)
  }
}

function paletteSignature(regions: readonly Region[]): string {
  return regions
    .slice(0, LABEL_PALETTE_MAX)
    .map((region) => `${region.id}:${region.color}:${region.visible ? 1 : 0}`)
    .join('|')
}

function labelSignature(regions: readonly Region[], plan: TexPlan | null): string {
  const bakeVisibility = plan?.stride.some((value) => value > 1) ?? false
  return regions
    .slice(0, LABEL_PALETTE_MAX)
    .map((region) => `${region.id}${bakeVisibility && !region.visible ? '!' : ''}`)
    .join(',')
}

export function createVolumeViewController(
  canvas: HTMLCanvasElement,
  onUnsupported: (reason: string | null) => void
): VolumeViewController {
  return new VolumeViewController(new Raycaster(canvas), new OrbitCamera(), { onUnsupported })
}
