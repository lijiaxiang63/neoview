import { describe, expect, it, vi } from 'vitest'
import type { SegPreview } from '../src/renderer/src/store'
import type { Region } from '../src/renderer/src/segmentation/regions'
import { packColor } from '../src/renderer/src/segmentation/regions'
import { PLANES } from '../src/renderer/src/slicing/extract'
import type { OverlayLayer } from '../src/renderer/src/slicing/overlay'
import {
  SliceRasterRenderer,
  type RasterExtractors,
  type RasterFactory,
  type SliceRasterInput
} from '../src/renderer/src/slicing/sliceRasterRenderer'
import type { Volume } from '../src/renderer/src/volume/types'

interface DrawRecord {
  canvas: FakeCanvas
  alpha: number
  smoothing: boolean
}

class FakeContext {
  globalAlpha = 0.25
  imageSmoothingEnabled = false
  imageSmoothingQuality: ImageSmoothingQuality = 'low'
  readonly draws: DrawRecord[] = []
  readonly events: string[]
  private stack: [number, boolean, ImageSmoothingQuality][] = []

  constructor(events: string[]) {
    this.events = events
  }

  clearRect(): void {
    this.events.push('clear')
  }

  save(): void {
    this.stack.push([this.globalAlpha, this.imageSmoothingEnabled, this.imageSmoothingQuality])
  }

  restore(): void {
    const state = this.stack.pop()!
    ;[this.globalAlpha, this.imageSmoothingEnabled, this.imageSmoothingQuality] = state
  }

  drawImage(canvas: FakeCanvas): void {
    this.draws.push({ canvas, alpha: this.globalAlpha, smoothing: this.imageSmoothingEnabled })
    this.events.push(`draw:${canvas.name}`)
  }

  putImageData(): void {
    this.events.push('put')
  }
}

class FakeCanvas {
  width = 0
  height = 0
  readonly context: FakeContext

  constructor(
    readonly name: string,
    events: string[]
  ) {
    this.context = new FakeContext(events)
  }

  getContext(): FakeContext {
    return this.context
  }
}

function imageData(width: number, height: number): ImageData {
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
    colorSpace: 'srgb'
  } as ImageData
}

function volume(dims: [number, number, number] = [4, 5, 6]): Volume {
  return {
    dims,
    frames: 1,
    spacing: [1, 1, 1],
    affine: new Float64Array(16),
    raw: new Uint8Array(dims[0] * dims[1] * dims[2]),
    slope: 1,
    inter: 0
  } as Volume
}

function overlay(id: number, kind: OverlayLayer['kind'] = 'map'): OverlayLayer {
  return {
    id,
    volume: volume(),
    kind,
    visible: true,
    opacity: 0.6,
    range: { lo: 0, hi: 1 },
    colormap: 'warm',
    hiddenLabels: new Set()
  }
}

const regions: Region[] = [
  { id: 1, name: 'Region 1', color: '#ff0000', visible: true, voxelCount: 1, stats: null }
]

const preview: SegPreview = {
  mask: new Uint8Array([1]),
  bounds: { min: [0, 0, 0], max: [0, 0, 0] },
  voxels: 1,
  components: 1,
  truncated: false,
  domain: { min: 0, max: 1, mean: 0.5 },
  histogram: { counts: new Uint32Array(1), min: 0, max: 1 }
}

function harness(): {
  renderer: SliceRasterRenderer
  target: FakeCanvas
  created: FakeCanvas[]
  events: string[]
  extractors: RasterExtractors
  input: SliceRasterInput
} {
  const events: string[] = []
  const created: FakeCanvas[] = []
  const factory: RasterFactory = {
    createCanvas: () => {
      const canvas = new FakeCanvas(`buffer-${created.length}`, events)
      created.push(canvas)
      return canvas as unknown as HTMLCanvasElement
    },
    createImageData: imageData
  }
  const extractors: RasterExtractors = {
    base: vi.fn(() => events.push('extract:base')),
    overlay: vi.fn((layer) => events.push(`extract:overlay-${layer.id}`)),
    regions: vi.fn(() => events.push('extract:regions')),
    preview: vi.fn(() => events.push('extract:preview'))
  }
  const renderer = new SliceRasterRenderer(factory, extractors)
  const target = new FakeCanvas('target', events)
  const input: SliceRasterInput = {
    canvas: target as unknown as HTMLCanvasElement,
    canvasSize: [300, 200],
    fit: { dx: 10, dy: 20, dw: 280, dh: 160, scale: 1 },
    volume: volume(),
    plane: PLANES[0],
    sliceIndex: 0,
    frame: 0,
    range: { lo: 0, hi: 1 },
    baseColormap: 'gray',
    overlays: [overlay(1, 'map'), overlay(2, 'mask')],
    labelMap: new Uint16Array(4 * 5 * 6),
    labelMapRevision: 0,
    regions,
    regionOpacity: 0.5,
    preview,
    nextRegionId: 2,
    editRegionId: null
  }
  return { renderer, target, created, events, extractors, input }
}

describe('slice raster renderer', () => {
  it('draws base, overlays, regions, then preview with layer settings', () => {
    const h = harness()
    h.renderer.render(h.input)
    expect(h.events.filter((event) => event.startsWith('extract:'))).toEqual([
      'extract:base',
      'extract:overlay-1',
      'extract:overlay-2',
      'extract:regions',
      'extract:preview'
    ])
    expect(h.target.context.draws.map(({ alpha, smoothing }) => [alpha, smoothing])).toEqual([
      [1, true],
      [0.6, true],
      [0.6, false],
      [0.5, false],
      [0.7, false]
    ])
  })

  it('skips hidden and zero-opacity overlays while preserving order', () => {
    const h = harness()
    h.input.overlays = [
      { ...overlay(3), visible: false },
      overlay(9),
      { ...overlay(4), opacity: 0 },
      overlay(2)
    ]
    h.input.labelMap = null
    h.input.preview = null
    h.renderer.render(h.input)
    expect(h.events.filter((event) => event.startsWith('extract:'))).toEqual([
      'extract:base',
      'extract:overlay-9',
      'extract:overlay-2'
    ])
  })

  it('restores context alpha, smoothing, and quality', () => {
    const h = harness()
    h.renderer.render(h.input)
    expect(h.target.context.globalAlpha).toBe(0.25)
    expect(h.target.context.imageSmoothingEnabled).toBe(false)
    expect(h.target.context.imageSmoothingQuality).toBe('low')
  })

  it('uses the target region color for a re-edit preview', () => {
    const h = harness()
    h.input.editRegionId = 1
    h.input.nextRegionId = 99
    h.renderer.render(h.input)
    expect(vi.mocked(h.extractors.preview).mock.calls[0][5]).toBe(packColor('#ff0000'))
  })

  it('reuses same-grid buffers and resizes only the target canvas', () => {
    const h = harness()
    h.renderer.render(h.input)
    const created = h.created.length
    const calls = {
      base: vi.mocked(h.extractors.base).mock.calls.length,
      overlay: vi.mocked(h.extractors.overlay).mock.calls.length,
      regions: vi.mocked(h.extractors.regions).mock.calls.length,
      preview: vi.mocked(h.extractors.preview).mock.calls.length
    }
    h.input.canvasSize = [600, 400]
    h.input.fit = { ...h.input.fit, dw: 560, dh: 320 }
    h.input.overlays = h.input.overlays.map((layer) => ({ ...layer, opacity: 0.25 }))
    h.input.regionOpacity = 0.8
    h.renderer.render(h.input)
    expect(h.created).toHaveLength(created)
    expect([h.target.width, h.target.height]).toEqual([600, 400])
    expect(vi.mocked(h.extractors.base)).toHaveBeenCalledTimes(calls.base)
    expect(vi.mocked(h.extractors.overlay)).toHaveBeenCalledTimes(calls.overlay)
    expect(vi.mocked(h.extractors.regions)).toHaveBeenCalledTimes(calls.regions)
    expect(vi.mocked(h.extractors.preview)).toHaveBeenCalledTimes(calls.preview)
  })

  it('invalidates only the overlay whose pixel settings changed', () => {
    const h = harness()
    h.renderer.render(h.input)
    h.input.overlays = [
      { ...h.input.overlays[0], range: { lo: 0.2, hi: 0.9 } },
      h.input.overlays[1]
    ]
    h.renderer.render(h.input)

    expect(vi.mocked(h.extractors.base)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(h.extractors.overlay).mock.calls.map(([layer]) => layer.id)).toEqual([1, 2, 1])
    expect(vi.mocked(h.extractors.regions)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(h.extractors.preview)).toHaveBeenCalledTimes(1)
  })

  it('reuses a single-frame overlay while the base plays later frames', () => {
    const h = harness()
    h.input.overlays = [overlay(1)]
    h.input.volume.frames = 3
    h.renderer.render(h.input)
    h.input.frame = 1
    h.renderer.render(h.input)
    h.input.frame = 2
    h.renderer.render(h.input)

    expect(vi.mocked(h.extractors.base)).toHaveBeenCalledTimes(3)
    expect(vi.mocked(h.extractors.overlay)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(h.extractors.overlay).mock.calls[0][4]).toBe(0)
  })

  it('invalidates a multi-frame overlay only when its resolved frame changes', () => {
    const h = harness()
    const layer = overlay(1)
    layer.volume.frames = 2
    h.input.overlays = [layer]
    h.input.volume.frames = 3
    h.renderer.render(h.input)
    h.input.frame = 1
    h.renderer.render(h.input)
    h.input.frame = 2
    h.renderer.render(h.input)

    expect(vi.mocked(h.extractors.overlay)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(h.extractors.overlay).mock.calls.map((call) => call[4])).toEqual([0, 1])
  })

  it('uses the label-map revision to invalidate only region pixels', () => {
    const h = harness()
    h.renderer.render(h.input)
    h.input.labelMapRevision++
    h.renderer.render(h.input)

    expect(vi.mocked(h.extractors.base)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(h.extractors.overlay)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(h.extractors.regions)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(h.extractors.preview)).toHaveBeenCalledTimes(1)
  })

  it('drops preview ownership when inactive while retaining the pixel allocation', () => {
    const h = harness()
    const oldPreview = h.input.preview
    h.renderer.render(h.input)
    const created = h.created.length

    h.input.preview = null
    h.renderer.render(h.input)
    h.input.preview = oldPreview
    h.renderer.render(h.input)

    expect(h.created).toHaveLength(created)
    expect(vi.mocked(h.extractors.preview)).toHaveBeenCalledTimes(2)
  })

  it('rebuilds buffers and releases old ones when volume or grid changes', () => {
    const h = harness()
    h.renderer.render(h.input)
    const old = [...h.created]
    h.input.volume = volume([7, 8, 9])
    h.renderer.render(h.input)
    for (const canvas of old) expect([canvas.width, canvas.height]).toEqual([0, 0])
    expect(h.created.length).toBeGreaterThan(old.length)
  })

  it('rebuilds buffers when volume identity changes at the same grid size', () => {
    const h = harness()
    h.renderer.render(h.input)
    const oldCanvases = [...h.created]
    const oldImage = vi.mocked(h.extractors.base).mock.calls[0][6]
    const replacement = volume()
    h.input.volume = replacement
    h.renderer.render(h.input)
    for (const canvas of oldCanvases) expect([canvas.width, canvas.height]).toEqual([0, 0])
    expect(h.created.length).toBeGreaterThan(oldCanvases.length)
    expect(vi.mocked(h.extractors.base).mock.calls[1][0]).toBe(replacement)
    expect(vi.mocked(h.extractors.base).mock.calls[1][6]).not.toBe(oldImage)
  })

  it('releases a removed overlay cache and does not draw it again', () => {
    const h = harness()
    h.input.labelMap = null
    h.input.preview = null
    h.renderer.render(h.input)
    const removed = h.target.context.draws[2].canvas
    h.input.overlays = [h.input.overlays[0]]
    h.renderer.render(h.input)
    expect([removed.width, removed.height]).toEqual([0, 0])
    expect(h.events.filter((event) => event === 'extract:overlay-2')).toHaveLength(1)
  })

  it('disposes every cache idempotently', () => {
    const h = harness()
    h.renderer.render(h.input)
    h.renderer.dispose()
    h.renderer.dispose()
    for (const canvas of h.created) expect([canvas.width, canvas.height]).toEqual([0, 0])
    const calls = vi.mocked(h.extractors.base).mock.calls.length
    h.renderer.render(h.input)
    expect(vi.mocked(h.extractors.base).mock.calls).toHaveLength(calls)
  })
})
