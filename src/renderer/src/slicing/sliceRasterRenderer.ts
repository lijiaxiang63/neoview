import type { BaseColormap, ModelPreview, SegPreview } from '../store'
import { modelClasses } from '../model/catalog'
import type { Region } from '../segmentation/regions'
import {
  defaultRegionColor,
  extractModelPreviewRGBA,
  extractPreviewRGBA,
  extractRegionsRGBA,
  packColor
} from '../segmentation/regions'
import type { Volume } from '../volume/types'
import { extractSliceToImageData, type PlaneSpec } from './extract'
import { buildMapLUT, extractOverlayRGBA, type OverlayLayer } from './overlay'
import type { ViewportFit } from './viewport'

interface RasterBuffer {
  canvas: HTMLCanvasElement
  image: ImageData
  /** Pixel-content signature; target geometry and compositing alpha are
   * deliberately excluded so those changes can redraw without re-extracting. */
  key: readonly unknown[] | null
}

export interface RasterFactory {
  createCanvas(): HTMLCanvasElement
  createImageData(width: number, height: number): ImageData
}

export interface RasterExtractors {
  base: typeof extractSliceToImageData
  overlay: typeof extractOverlayRGBA
  regions: typeof extractRegionsRGBA
  preview: typeof extractPreviewRGBA
  modelPreview: typeof extractModelPreviewRGBA
}

export interface SliceRasterInput {
  canvas: HTMLCanvasElement
  canvasSize: [number, number]
  fit: ViewportFit
  volume: Volume
  plane: PlaneSpec
  sliceIndex: number
  frame: number
  range: { lo: number; hi: number }
  baseColormap: BaseColormap
  overlays: readonly OverlayLayer[]
  labelMap: Uint16Array | null
  /** Invalidates drawing when the in-place label map changes. */
  labelMapRevision: number
  regions: readonly Region[]
  regionOpacity: number
  preview: SegPreview | null
  modelPreview: ModelPreview | null
  nextRegionId: number
  editRegionId: number | null
}

const browserFactory: RasterFactory = {
  createCanvas: () => document.createElement('canvas'),
  createImageData: (width, height) => new ImageData(width, height)
}

const defaultExtractors: RasterExtractors = {
  base: extractSliceToImageData,
  overlay: extractOverlayRGBA,
  regions: extractRegionsRGBA,
  preview: extractPreviewRGBA,
  modelPreview: extractModelPreviewRGBA
}

function contextOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('2D canvas context unavailable')
  return context
}

function sameKey(a: readonly unknown[] | null, b: readonly unknown[]): boolean {
  return (
    a !== null && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  )
}

function regionStyleKey(regions: readonly Region[]): string {
  return regions.map((region) => `${region.id}:${region.visible ? 1 : 0}:${region.color}`).join('|')
}

function nonzeroModelCount(preview: ModelPreview): number {
  let total = 0
  for (let index = 1; index < preview.counts.length; index++) total += preview.counts[index]
  return total
}

function modelColors(preview: ModelPreview): Uint32Array {
  const classes = modelClasses(preview.variantId)
  const colors = new Uint32Array(classes.length)
  for (const item of classes) colors[item.value] = packColor(item.color)
  return colors
}

export class SliceRasterRenderer {
  private readonly factory: RasterFactory
  private readonly extractors: RasterExtractors
  private volume: Volume | null = null
  private width = 0
  private height = 0
  private baseBuffer: RasterBuffer | null = null
  private readonly overlayBuffers = new Map<number, RasterBuffer>()
  private regionBuffer: RasterBuffer | null = null
  private previewBuffer: RasterBuffer | null = null
  private modelPreviewBuffer: RasterBuffer | null = null
  private colorRegions: readonly Region[] | null = null
  private colorOf: Uint32Array | null = null
  private disposed = false

  constructor(
    factory: RasterFactory = browserFactory,
    extractors: RasterExtractors = defaultExtractors
  ) {
    this.factory = factory
    this.extractors = extractors
  }

  render(input: SliceRasterInput): void {
    if (this.disposed) return
    const width = input.volume.dims[input.plane.colAxis]
    const height = input.volume.dims[input.plane.rowAxis]
    if (this.volume !== input.volume || this.width !== width || this.height !== height) {
      this.resetGrid(input.volume, width, height)
    }

    const [canvasWidth, canvasHeight] = input.canvasSize
    if (input.canvas.width !== canvasWidth || input.canvas.height !== canvasHeight) {
      input.canvas.width = canvasWidth
      input.canvas.height = canvasHeight
    }

    const base = this.baseBuffer ?? (this.baseBuffer = this.createBuffer())
    const baseKey = [
      input.volume,
      input.plane,
      input.sliceIndex,
      input.frame,
      input.range.lo,
      input.range.hi,
      input.baseColormap
    ] as const
    if (!sameKey(base.key, baseKey)) {
      const baseLut = input.baseColormap === 'gray' ? null : buildMapLUT(input.baseColormap).pos
      this.extractors.base(
        input.volume,
        input.plane,
        input.sliceIndex,
        input.frame,
        input.range.lo,
        input.range.hi,
        base.image,
        baseLut
      )
      contextOf(base.canvas).putImageData(base.image, 0, 0)
      base.key = baseKey
    }

    this.dropRemovedOverlays(input.overlays)
    const context = contextOf(input.canvas)
    context.clearRect(0, 0, canvasWidth, canvasHeight)
    context.save()
    try {
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.globalAlpha = 1
      context.drawImage(base.canvas, input.fit.dx, input.fit.dy, input.fit.dw, input.fit.dh)

      for (const layer of input.overlays) {
        if (!layer.visible || layer.opacity <= 0) continue
        let buffer = this.overlayBuffers.get(layer.id)
        if (!buffer) {
          buffer = this.createBuffer()
          this.overlayBuffers.set(layer.id, buffer)
        }
        const overlayFrame = Math.min(input.frame, layer.volume.frames - 1)
        const overlayKey = [
          layer.volume,
          input.volume,
          input.plane,
          input.sliceIndex,
          overlayFrame,
          layer.kind,
          layer.range.lo,
          layer.range.hi,
          layer.colormap,
          layer.hiddenLabels,
          layer.labelTable,
          // Only the fields the display gate reads — not the significance object
          // identity — so re-annotating the cluster report never re-extracts pixels.
          layer.significance?.statThreshold ?? null,
          layer.significance?.mask ?? null,
          layer.significance?.kind ?? null,
          layer.significance?.tail ?? null
        ] as const
        if (!sameKey(buffer.key, overlayKey)) {
          this.extractors.overlay(
            layer,
            input.volume,
            input.plane,
            input.sliceIndex,
            overlayFrame,
            buffer.image
          )
          contextOf(buffer.canvas).putImageData(buffer.image, 0, 0)
          buffer.key = overlayKey
        }
        context.imageSmoothingEnabled = layer.kind === 'map'
        context.globalAlpha = layer.opacity
        context.drawImage(buffer.canvas, input.fit.dx, input.fit.dy, input.fit.dw, input.fit.dh)
      }

      if (
        input.labelMap &&
        input.regionOpacity > 0 &&
        input.regions.some((region) => region.visible)
      ) {
        const buffer = this.regionBuffer ?? (this.regionBuffer = this.createBuffer())
        const regionKey = [
          input.labelMap,
          input.labelMapRevision,
          input.plane,
          input.sliceIndex,
          regionStyleKey(input.regions)
        ] as const
        if (!sameKey(buffer.key, regionKey)) {
          this.extractors.regions(
            input.labelMap,
            input.volume.dims,
            input.plane,
            input.sliceIndex,
            this.regionColors(input.regions),
            buffer.image
          )
          contextOf(buffer.canvas).putImageData(buffer.image, 0, 0)
          buffer.key = regionKey
        }
        context.imageSmoothingEnabled = false
        context.globalAlpha = input.regionOpacity
        context.drawImage(buffer.canvas, input.fit.dx, input.fit.dy, input.fit.dw, input.fit.dh)
      }

      if (input.preview && input.preview.voxels > 0) {
        const buffer = this.previewBuffer ?? (this.previewBuffer = this.createBuffer())
        const previewColor =
          input.regions.find((region) => region.id === input.editRegionId)?.color ??
          defaultRegionColor(input.nextRegionId)
        const packedPreviewColor = packColor(previewColor)
        const previewKey = [
          input.preview,
          input.plane,
          input.sliceIndex,
          packedPreviewColor
        ] as const
        if (!sameKey(buffer.key, previewKey)) {
          this.extractors.preview(
            input.preview.mask,
            input.preview.bounds,
            input.volume.dims,
            input.plane,
            input.sliceIndex,
            packedPreviewColor,
            buffer.image
          )
          contextOf(buffer.canvas).putImageData(buffer.image, 0, 0)
          buffer.key = previewKey
        }
        context.imageSmoothingEnabled = false
        context.globalAlpha = 0.7
        context.drawImage(buffer.canvas, input.fit.dx, input.fit.dy, input.fit.dw, input.fit.dh)
      } else if (this.previewBuffer) {
        // Keep the reusable pixel allocation, but release the old preview and
        // its potentially large mask as soon as store ownership ends.
        this.previewBuffer.key = null
      }

      if (input.modelPreview && nonzeroModelCount(input.modelPreview) > 0) {
        const buffer = this.modelPreviewBuffer ?? (this.modelPreviewBuffer = this.createBuffer())
        const previewKey = [input.modelPreview, input.plane, input.sliceIndex] as const
        if (!sameKey(buffer.key, previewKey)) {
          this.extractors.modelPreview(
            input.modelPreview.labels,
            input.volume.dims,
            input.plane,
            input.sliceIndex,
            modelColors(input.modelPreview),
            buffer.image
          )
          contextOf(buffer.canvas).putImageData(buffer.image, 0, 0)
          buffer.key = previewKey
        }
        context.imageSmoothingEnabled = false
        context.globalAlpha = 0.7
        context.drawImage(buffer.canvas, input.fit.dx, input.fit.dy, input.fit.dw, input.fit.dh)
      } else if (this.modelPreviewBuffer) {
        this.modelPreviewBuffer.key = null
      }
    } finally {
      context.restore()
    }
  }

  reset(): void {
    this.releaseBuffer(this.baseBuffer)
    for (const buffer of this.overlayBuffers.values()) this.releaseBuffer(buffer)
    this.releaseBuffer(this.regionBuffer)
    this.releaseBuffer(this.previewBuffer)
    this.releaseBuffer(this.modelPreviewBuffer)
    this.baseBuffer = null
    this.overlayBuffers.clear()
    this.regionBuffer = null
    this.previewBuffer = null
    this.modelPreviewBuffer = null
    this.volume = null
    this.width = 0
    this.height = 0
    this.colorRegions = null
    this.colorOf = null
  }

  dispose(): void {
    if (this.disposed) return
    this.reset()
    this.disposed = true
  }

  private resetGrid(volume: Volume, width: number, height: number): void {
    this.reset()
    this.volume = volume
    this.width = width
    this.height = height
  }

  private createBuffer(): RasterBuffer {
    const canvas = this.factory.createCanvas()
    canvas.width = this.width
    canvas.height = this.height
    return { canvas, image: this.factory.createImageData(this.width, this.height), key: null }
  }

  private releaseBuffer(buffer: RasterBuffer | null): void {
    if (!buffer) return
    buffer.canvas.width = 0
    buffer.canvas.height = 0
  }

  private dropRemovedOverlays(overlays: readonly OverlayLayer[]): void {
    const retained = new Set(overlays.map((layer) => layer.id))
    for (const [id, buffer] of this.overlayBuffers) {
      if (!retained.has(id)) {
        this.releaseBuffer(buffer)
        this.overlayBuffers.delete(id)
      }
    }
  }

  private regionColors(regions: readonly Region[]): Uint32Array {
    if (this.colorRegions === regions && this.colorOf) return this.colorOf
    const maxId = regions.reduce((max, region) => Math.max(max, region.id), 0)
    const colorOf = new Uint32Array(maxId + 1)
    for (const region of regions) if (region.visible) colorOf[region.id] = packColor(region.color)
    this.colorRegions = regions
    this.colorOf = colorOf
    return colorOf
  }
}
