import type { Volume } from '../volume/types'
import { applyAffine, composeVoxelMap } from '../volume/affine'
import type { PlaneSpec } from './extract'

export type OverlayKind = 'map' | 'mask' | 'labels'
export type ColormapName = 'warm' | 'cool' | 'signed'

export interface OverlayLayer {
  id: number
  volume: Volume
  kind: OverlayKind
  visible: boolean
  /** 0..1, applied as globalAlpha at draw time. */
  opacity: number
  /** Display window for the map kind; magnitude window for 'signed'. */
  range: { lo: number; hi: number }
  colormap: ColormapName
  /** Label ids suppressed in the labels kind (empty = all visible). */
  hiddenLabels: ReadonlySet<number>
}

// ---------------------------------------------------------------------------
// Grid alignment

interface MapCacheEntry {
  base: Volume
  m: Float64Array | null
}

const voxelMapCache = new WeakMap<Volume, MapCacheEntry>()

/**
 * Cached M = inv(A_overlay) · A_base mapping base voxel coords to overlay
 * voxel coords; null when the overlay affine is singular. Recomputed when the
 * base volume changes identity.
 */
export function voxelMapFor(base: Volume, overlay: Volume): Float64Array | null {
  const hit = voxelMapCache.get(overlay)
  if (hit && hit.base === base) return hit.m
  const m = composeVoxelMap(base.affine, overlay.affine)
  voxelMapCache.set(overlay, { base, m })
  return m
}

// ---------------------------------------------------------------------------
// Colors. Pixels are packed for a little-endian Uint32 view over
// ImageData.data, matching extract.ts: (a<<24) | (b<<16) | (g<<8) | r.

function packRGB(r: number, g: number, b: number): number {
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0
}

type Stops = [number, number, number][]

const WARM_STOPS: Stops = [
  [20, 0, 0],
  [230, 60, 20],
  [255, 200, 40],
  [255, 255, 220]
]

const COOL_STOPS: Stops = [
  [0, 10, 40],
  [30, 90, 220],
  [60, 200, 255],
  [230, 255, 255]
]

function rampLUT(stops: Stops): Uint32Array {
  const lut = new Uint32Array(256)
  const segs = stops.length - 1
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * segs
    const s = Math.min(Math.floor(t), segs - 1)
    const f = t - s
    const a = stops[s]
    const b = stops[s + 1]
    lut[i] = packRGB(
      Math.round(a[0] + (b[0] - a[0]) * f),
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f)
    )
  }
  return lut
}

export interface MapLUT {
  pos: Uint32Array
  /** Second arm for the diverging colormap; null for sequential ones. */
  neg: Uint32Array | null
}

const lutCache = new Map<ColormapName, MapLUT>()

/** 256-entry RGBA LUT(s) for a colormap; built once and cached. */
export function buildMapLUT(name: ColormapName): MapLUT {
  let lut = lutCache.get(name)
  if (!lut) {
    lut =
      name === 'signed'
        ? { pos: rampLUT(WARM_STOPS), neg: rampLUT(COOL_STOPS) }
        : { pos: rampLUT(name === 'warm' ? WARM_STOPS : COOL_STOPS), neg: null }
    lutCache.set(name, lut)
  }
  return lut
}

function hslToPacked(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return packRGB(Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255))
}

// Slice extraction may see arbitrary numeric values in label mode. Cache the
// common compact range only; overflow colors remain deterministic without
// retaining one entry per distinct value for the renderer lifetime.
const LABEL_COLOR_CACHE_SIZE = 4096
const labelCache = new Uint32Array(LABEL_COLOR_CACHE_SIZE)

/**
 * Deterministic distinct color per label id: golden-angle hue walk with
 * lightness alternating by parity so adjacent ids stay far apart.
 */
export function labelColor(id: number): number {
  const cacheable = Number.isInteger(id) && id >= 0 && id < LABEL_COLOR_CACHE_SIZE
  if (cacheable && labelCache[id] !== 0) return labelCache[id]
  const hue = (((id * 137.50776405003785) % 360) + 360) % 360
  const color = hslToPacked(hue, 0.72, id % 2 === 0 ? 0.62 : 0.5)
  if (cacheable) {
    labelCache[id] = color
  }
  return color
}

export const MASK_COLOR = packRGB(255, 80, 40)

/** CSS color string matching labelColor's packed value, for UI swatches. */
export function labelColorCSS(id: number): string {
  const c = labelColor(id)
  return `rgb(${c & 0xff}, ${(c >>> 8) & 0xff}, ${(c >>> 16) & 0xff})`
}

/** Cap on enumerated ids for volumes without a name table. */
export const MAX_LISTED_LABELS = 512

export interface LabelEntry {
  id: number
  /** Voxels carrying this id (frame 0). */
  count: number
  /** Representative voxel (the one nearest the label's centroid, so it always
   * lies on the label even for concave shapes); null when count is 0. */
  pos: [number, number, number] | null
}

const inventoryCache = new WeakMap<Volume, LabelEntry[]>()

/**
 * Per-id voxel counts and representative positions, ascending by id, from one
 * memoized two-pass scan of frame 0. Name-table ids that never occur in the
 * data are included with count 0 (so the UI can show them); ids beyond
 * MAX_LISTED_LABELS distinct values are dropped.
 */
export function labelInventory(vol: Volume): LabelEntry[] {
  let entries = inventoryCache.get(vol)
  if (entries) return entries

  const [nx, ny, nz] = vol.dims
  const { raw, slope, inter } = vol
  const acc = new Map<number, { count: number; si: number; sj: number; sk: number }>()

  // Pass 1: counts and coordinate sums (centroids).
  let idx = 0
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, idx++) {
        const id = Math.round(raw[idx] * slope + inter)
        if (id === 0 || !Number.isFinite(id)) continue
        let a = acc.get(id)
        if (!a) {
          if (acc.size >= MAX_LISTED_LABELS) continue
          a = { count: 0, si: 0, sj: 0, sk: 0 }
          acc.set(id, a)
        }
        a.count++
        a.si += i
        a.sj += j
        a.sk += k
      }
    }
  }

  // Pass 2: per id, the actual voxel nearest the centroid.
  const best = new Map<number, { d: number; pos: [number, number, number] }>()
  idx = 0
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, idx++) {
        const id = Math.round(raw[idx] * slope + inter)
        const a = id !== 0 && Number.isFinite(id) ? acc.get(id) : undefined
        if (!a) continue
        const di = i - a.si / a.count
        const dj = j - a.sj / a.count
        const dk = k - a.sk / a.count
        const d = di * di + dj * dj + dk * dk
        const b = best.get(id)
        if (!b || d < b.d) best.set(id, { d, pos: [i, j, k] })
      }
    }
  }

  const ids = new Set<number>(acc.keys())
  if (vol.labels) for (const id of vol.labels.keys()) ids.add(id)
  entries = [...ids]
    .sort((a, b) => a - b)
    .slice(0, MAX_LISTED_LABELS)
    .map((id) => ({
      id,
      count: acc.get(id)?.count ?? 0,
      pos: best.get(id)?.pos ?? null
    }))
  inventoryCache.set(vol, entries)
  return entries
}

/** Distinct label ids, ascending (see labelInventory). */
export function listLabelIds(vol: Volume): number[] {
  return labelInventory(vol).map((e) => e.id)
}

/**
 * Map an overlay voxel coordinate into the base grid (for jumping the
 * crosshair to a label); null when the base affine is singular.
 */
export function overlayVoxelToBase(
  base: Volume,
  overlay: Volume,
  ijk: [number, number, number]
): [number, number, number] | null {
  const m = composeVoxelMap(overlay.affine, base.affine)
  if (!m) return null
  const [x, y, z] = applyAffine(m, ijk[0], ijk[1], ijk[2])
  return [Math.round(x), Math.round(y), Math.round(z)]
}

// ---------------------------------------------------------------------------
// Kind heuristic and defaults

/** Guess a layer kind: an embedded name table settles it; otherwise from
 * stats — exact {0,1} → mask, small non-negative integer range → labels,
 * anything else → map. */
export function guessOverlayKind(vol: Volume): OverlayKind {
  if (vol.labels) return 'labels'
  const { stats, slope, inter } = vol
  if (stats.typeRange !== null && slope === 1 && inter === 0 && stats.dataMin >= 0) {
    if (stats.dataMax === 1) return 'mask'
    if (stats.dataMax <= 1024) return 'labels'
  }
  return 'map'
}

export interface LayerSettings {
  range: { lo: number; hi: number }
  colormap: ColormapName
}

/** Initial colormap and display window for a fresh layer. The range is
 * populated for every kind so switching to 'map' later needs no re-derivation. */
export function defaultLayerSettings(vol: Volume): LayerSettings {
  const { stats } = vol
  if (stats.dataMin < 0) {
    return {
      range: { lo: 0, hi: Math.max(Math.abs(stats.dataMin), stats.dataMax) },
      colormap: 'signed'
    }
  }
  const range =
    vol.suggestedRange ??
    (stats.p2 === stats.p98
      ? { lo: stats.dataMin, hi: stats.dataMax }
      : { lo: stats.p2, hi: stats.p98 })
  return { range: { ...range }, colormap: 'warm' }
}

// ---------------------------------------------------------------------------
// Extraction

/**
 * Fill img (sized to the base slice grid) with the layer's RGBA for one base
 * slice. Alpha 0 for: out of overlay bounds, map value outside the display
 * window, label 0, mask 0, NaN. Rows are written bottom-up, matching
 * extractSliceToImageData. The shared frame index is clamped to the overlay's
 * own frame count.
 */
export function extractOverlayRGBA(
  layer: OverlayLayer,
  base: Volume,
  plane: PlaneSpec,
  sliceIdx: number,
  frame: number,
  img: ImageData
): void {
  const px = new Uint32Array(img.data.buffer)
  const m = voxelMapFor(base, layer.volume)
  if (!m) {
    px.fill(0)
    return
  }
  const w = base.dims[plane.colAxis]
  const h = base.dims[plane.rowAxis]
  const ov = layer.volume
  const [nx, ny, nz] = ov.dims
  const sy = nx
  const sz = nx * ny
  const { raw, slope, inter } = ov
  const frameOff = Math.min(frame, ov.frames - 1) * nx * ny * nz

  // Overlay-space coordinate of base pixel (c=0, r=0) plus the per-column and
  // per-row step vectors (columns of M) — 3 adds per pixel, no matrix multiply.
  const p0: [number, number, number] = [0, 0, 0]
  p0[plane.sliceAxis] = sliceIdx
  const [ox, oy, oz] = applyAffine(m, p0[0], p0[1], p0[2])
  const cx = m[plane.colAxis]
  const cy = m[4 + plane.colAxis]
  const cz = m[8 + plane.colAxis]
  const rx = m[plane.rowAxis]
  const ry = m[4 + plane.rowAxis]
  const rz = m[8 + plane.rowAxis]

  const { kind, hiddenLabels: hidden } = layer
  const { lo, hi } = layer.range
  const scale = 255 / Math.max(hi - lo, 1e-12)
  const lut = kind === 'map' ? buildMapLUT(layer.colormap) : null
  const signed = lut !== null && lut.neg !== null
  const anyHidden = hidden.size > 0

  let p = 0
  for (let r = h - 1; r >= 0; r--) {
    // Fresh row start (no drift accumulation across rows).
    let x = ox + r * rx
    let y = oy + r * ry
    let z = oz + r * rz
    for (let c = 0; c < w; c++, p++, x += cx, y += cy, z += cz) {
      const xi = Math.round(x)
      const yi = Math.round(y)
      const zi = Math.round(z)
      if (xi < 0 || xi >= nx || yi < 0 || yi >= ny || zi < 0 || zi >= nz) {
        px[p] = 0
        continue
      }
      const v = raw[frameOff + xi + yi * sy + zi * sz] * slope + inter
      if (!Number.isFinite(v)) {
        px[p] = 0
      } else if (kind === 'mask') {
        px[p] = v !== 0 ? MASK_COLOR : 0
      } else if (kind === 'labels') {
        const id = Math.round(v)
        px[p] = id !== 0 && !(anyHidden && hidden.has(id)) ? labelColor(id) : 0
      } else if (signed) {
        const a = Math.abs(v)
        if (a < lo) {
          px[p] = 0
        } else {
          let t = ((a - lo) * scale) | 0
          t = t > 255 ? 255 : t
          px[p] = v >= 0 ? lut!.pos[t] : lut!.neg![t]
        }
      } else if (v < lo) {
        px[p] = 0
      } else {
        let t = ((v - lo) * scale) | 0
        t = t > 255 ? 255 : t
        px[p] = lut!.pos[t]
      }
    }
  }
}

/**
 * Scaled overlay value at a base voxel coordinate (for the hover readout), or
 * null when the grids cannot be aligned or the coordinate maps out of bounds.
 */
export function sampleOverlayAt(
  layer: OverlayLayer,
  base: Volume,
  ijk: [number, number, number],
  frame: number
): number | null {
  const m = voxelMapFor(base, layer.volume)
  if (!m) return null
  const ov = layer.volume
  const [x, y, z] = applyAffine(m, ijk[0], ijk[1], ijk[2])
  const xi = Math.round(x)
  const yi = Math.round(y)
  const zi = Math.round(z)
  const [nx, ny, nz] = ov.dims
  if (xi < 0 || xi >= nx || yi < 0 || yi >= ny || zi < 0 || zi >= nz) return null
  const frameOff = Math.min(frame, ov.frames - 1) * nx * ny * nz
  const value = ov.raw[frameOff + xi + yi * nx + zi * nx * ny] * ov.slope + ov.inter
  return Number.isFinite(value) ? value : null
}
