import type { Volume } from '../volume/types'
import type { PlaneSpec } from '../slicing/extract'
import { boxExtent, type SegBox } from './segment'

/** One user-created region; its voxels live in the shared label map. */
export interface Region {
  /** Value this region's voxels carry in the label map (1-based, never reused). */
  id: number
  name: string
  /** '#rrggbb' — editable via a color input. */
  color: string
  visible: boolean
  voxelCount: number
  /** Scaled-intensity stats over the region's voxels; null when empty. */
  stats: { min: number; max: number; mean: number } | null
}

// ---------------------------------------------------------------------------
// Colors

/** Golden-angle hue walk (same scheme as overlay label colors), as hex. */
export function defaultRegionColor(id: number): string {
  const h = (id * 137.50776405003785) % 360
  const s = 0.72
  const l = id % 2 === 0 ? 0.62 : 0.5
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
  const hex = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

/** '#rrggbb' → packed value for a little-endian Uint32 view over RGBA bytes. */
export function packColor(css: string): number {
  const v = parseInt(css.slice(1), 16)
  const r = (v >>> 16) & 0xff
  const g = (v >>> 8) & 0xff
  const b = v & 0xff
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0
}

export function colorComponents(css: string): [number, number, number] {
  const v = parseInt(css.slice(1), 16)
  return [(v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
}

// ---------------------------------------------------------------------------
// Label-map edits (all mutate the shared Uint16Array in place). Every editor
// takes an optional change collector so gestures can be undone: it receives
// (index, oldValue) for each voxel BEFORE the first write.

export interface ChangeSink {
  record(index: number, oldValue: number): void
}

/** Write a box-shaped binary mask into the label map as region `id`,
 * overwriting whatever was there. Returns the number of voxels written. */
export function applyMaskAsRegion(
  labelMap: Uint16Array,
  dims: [number, number, number],
  box: SegBox,
  mask: Uint8Array,
  id: number,
  changes: ChangeSink | null = null
): number {
  const [nx, ny] = dims
  let written = 0
  let p = 0
  for (let k = box.min[2]; k <= box.max[2]; k++) {
    for (let j = box.min[1]; j <= box.max[1]; j++) {
      let idx = box.min[0] + j * nx + k * nx * ny
      for (let i = box.min[0]; i <= box.max[0]; i++, idx++, p++) {
        if (mask[p] !== 0) {
          if (changes && labelMap[idx] !== id) changes.record(idx, labelMap[idx])
          labelMap[idx] = id
          written++
        }
      }
    }
  }
  return written
}

/** Clear a region's voxels, returning their indices so delete can be undone. */
export function eraseRegion(labelMap: Uint16Array, id: number): Uint32Array {
  let n = 0
  for (let i = 0; i < labelMap.length; i++) if (labelMap[i] === id) n++
  const indices = new Uint32Array(n)
  let p = 0
  for (let i = 0; i < labelMap.length; i++) {
    if (labelMap[i] === id) {
      indices[p++] = i
      labelMap[i] = 0
    }
  }
  return indices
}

/** Clear one region in a single pass while feeding a caller-owned patch
 * collector. Used by large replacement commits to avoid first materializing a
 * second full index list. */
export function eraseRegionInto(labelMap: Uint16Array, id: number, changes: ChangeSink): number {
  let erased = 0
  for (let index = 0; index < labelMap.length; index++) {
    if (labelMap[index] !== id) continue
    changes.record(index, id)
    labelMap[index] = 0
    erased++
  }
  return erased
}

/** Tight bounding box of a region's voxels; null when it has none. */
export function regionBoundingBox(
  labelMap: Uint16Array,
  dims: [number, number, number],
  id: number
): SegBox | null {
  const [nx, ny] = dims
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  let any = false
  for (let idx = 0; idx < labelMap.length; idx++) {
    if (labelMap[idx] !== id) continue
    any = true
    const i = idx % nx
    const j = ((idx / nx) | 0) % ny
    const k = (idx / (nx * ny)) | 0
    if (i < min[0]) min[0] = i
    if (i > max[0]) max[0] = i
    if (j < min[1]) min[1] = j
    if (j > max[1]) max[1] = j
    if (k < min[2]) min[2] = k
    if (k > max[2]) max[2] = k
  }
  return any ? { min, max } : null
}

/** Undo an erase: restore `id` at the recorded indices, but only where the
 * voxel is still unclaimed so later edits are not clobbered. */
export function restoreRegion(labelMap: Uint16Array, indices: Uint32Array, id: number): void {
  for (let p = 0; p < indices.length; p++) {
    const idx = indices[p]
    if (labelMap[idx] === 0) labelMap[idx] = id
  }
}

/**
 * Stamp a filled disk on one slice: sets voxels to `id`, or (erase) clears
 * voxels currently carrying `id`. Center is (col,row) on the plane's in-plane
 * axes; radius is in voxels.
 */
export function paintDisk(
  labelMap: Uint16Array,
  dims: [number, number, number],
  plane: PlaneSpec,
  sliceIdx: number,
  center: [number, number],
  radius: number,
  id: number,
  erase: boolean,
  changes: ChangeSink | null = null
): number {
  const w = dims[plane.colAxis]
  const h = dims[plane.rowAxis]
  const stride = [1, dims[0], dims[0] * dims[1]]
  const cs = stride[plane.colAxis]
  const rs = stride[plane.rowAxis]
  const base = sliceIdx * stride[plane.sliceAxis]
  const r2 = radius * radius
  const c0 = Math.max(0, Math.ceil(center[0] - radius))
  const c1 = Math.min(w - 1, Math.floor(center[0] + radius))
  const rr0 = Math.max(0, Math.ceil(center[1] - radius))
  const rr1 = Math.min(h - 1, Math.floor(center[1] + radius))
  let changed = 0
  for (let r = rr0; r <= rr1; r++) {
    const dr = r - center[1]
    for (let c = c0; c <= c1; c++) {
      const dc = c - center[0]
      if (dc * dc + dr * dr > r2) continue
      const idx = base + c * cs + r * rs
      if (erase) {
        if (labelMap[idx] === id) {
          changes?.record(idx, id)
          labelMap[idx] = 0
          changed++
        }
      } else if (labelMap[idx] !== id) {
        changes?.record(idx, labelMap[idx])
        labelMap[idx] = id
        changed++
      }
    }
  }
  return changed
}

/** Stamp disks along a segment so fast drags leave no gaps. */
export function paintStroke(
  labelMap: Uint16Array,
  dims: [number, number, number],
  plane: PlaneSpec,
  sliceIdx: number,
  from: [number, number],
  to: [number, number],
  radius: number,
  id: number,
  erase: boolean,
  changes: ChangeSink | null = null
): number {
  const dist = Math.hypot(to[0] - from[0], to[1] - from[1])
  const steps = Math.max(1, Math.ceil(dist / Math.max(radius * 0.5, 0.5)))
  let changed = 0
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    changed += paintDisk(
      labelMap,
      dims,
      plane,
      sliceIdx,
      [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t],
      radius,
      id,
      erase,
      changes
    )
  }
  return changed
}

// ---------------------------------------------------------------------------
// Stats

/** One pass over the label map: per-region voxel count and intensity stats. */
export function computeRegionStats(
  vol: Volume,
  labelMap: Uint16Array,
  regions: Region[],
  frameOffset = 0
): Region[] {
  if (regions.length === 0) return regions
  const maxId = regions.reduce((m, r) => Math.max(m, r.id), 0)
  const count = new Uint32Array(maxId + 1)
  // NaN voxels count toward size but not toward intensity stats.
  const finite = new Uint32Array(maxId + 1)
  const sum = new Float64Array(maxId + 1)
  const min = new Float64Array(maxId + 1).fill(Infinity)
  const max = new Float64Array(maxId + 1).fill(-Infinity)
  const { raw, slope, inter } = vol
  for (let i = 0; i < labelMap.length; i++) {
    const id = labelMap[i]
    if (id === 0 || id > maxId) continue
    const v = raw[frameOffset + i] * slope + inter
    count[id]++
    if (Number.isNaN(v)) continue
    finite[id]++
    sum[id] += v
    if (v < min[id]) min[id] = v
    if (v > max[id]) max[id] = v
  }
  return regions.map((r) => ({
    ...r,
    voxelCount: count[r.id],
    stats:
      finite[r.id] > 0 ? { min: min[r.id], max: max[r.id], mean: sum[r.id] / finite[r.id] } : null
  }))
}

// ---------------------------------------------------------------------------
// Slice rendering (mirrors extractOverlayRGBA's screen directions)

/**
 * Fill img (sized to the base slice grid) with region colors for one slice.
 * colorOf is indexed by region id; 0 means transparent (hidden/deleted ids).
 */
export function extractRegionsRGBA(
  labelMap: Uint16Array,
  dims: [number, number, number],
  plane: PlaneSpec,
  sliceIdx: number,
  colorOf: Uint32Array,
  img: ImageData
): void {
  const px = new Uint32Array(img.data.buffer)
  const w = dims[plane.colAxis]
  const h = dims[plane.rowAxis]
  const stride = [1, dims[0], dims[0] * dims[1]]
  const cs = stride[plane.colAxis]
  const rs = stride[plane.rowAxis]
  const base = sliceIdx * stride[plane.sliceAxis]
  const colStart = plane.colDirection > 0 ? 0 : w - 1
  const rowStart = plane.rowDirection > 0 ? h - 1 : 0
  const colStep = cs * plane.colDirection
  const rowStep = -plane.rowDirection
  let p = 0
  for (let screenRow = 0, r = rowStart; screenRow < h; screenRow++, r += rowStep) {
    let idx = base + r * rs + colStart * cs
    for (let c = 0; c < w; c++, idx += colStep, p++) {
      const id = labelMap[idx]
      px[p] = id !== 0 && id < colorOf.length ? colorOf[id] : 0
    }
  }
}

/** Fill img with the pending preview mask (box-local) for one slice. */
export function extractPreviewRGBA(
  mask: Uint8Array,
  box: SegBox,
  dims: [number, number, number],
  plane: PlaneSpec,
  sliceIdx: number,
  color: number,
  img: ImageData
): void {
  const px = new Uint32Array(img.data.buffer)
  px.fill(0)
  if (sliceIdx < box.min[plane.sliceAxis] || sliceIdx > box.max[plane.sliceAxis]) return
  const [bw, bh] = [boxExtent(box)[0], boxExtent(box)[1]]
  const bstride = [1, bw, bw * bh]
  const bcs = bstride[plane.colAxis]
  const brs = bstride[plane.rowAxis]
  const bbase = (sliceIdx - box.min[plane.sliceAxis]) * bstride[plane.sliceAxis]
  const w = dims[plane.colAxis]
  const h = dims[plane.rowAxis]
  const c0 = box.min[plane.colAxis]
  const c1 = box.max[plane.colAxis]
  const r0 = box.min[plane.rowAxis]
  const r1 = box.max[plane.rowAxis]
  for (let r = r0; r <= r1; r++) {
    const screenRow = plane.rowDirection > 0 ? h - 1 - r : r
    let bidx = bbase + (r - r0) * brs
    for (let c = c0; c <= c1; c++, bidx += bcs) {
      const screenColumn = plane.colDirection > 0 ? c : w - 1 - c
      if (mask[bidx] !== 0) px[screenRow * w + screenColumn] = color
    }
  }
}

// ---------------------------------------------------------------------------
// Export helpers

export interface ExportEntry {
  /** Value written to the exported label map (sequential from 1). */
  value: number
  region: Region
}

/** Remap internal region ids (which can have gaps after deletes) to
 * sequential export values 1..N in list order. */
export function remapForExport(
  labelMap: Uint16Array,
  regions: Region[]
): { data: Uint16Array; entries: ExportEntry[] } {
  const entries = regions.map((region, i) => ({ value: i + 1, region }))
  const maxId = regions.reduce((m, r) => Math.max(m, r.id), 0)
  const valueOf = new Uint16Array(maxId + 1)
  for (const e of entries) valueOf[e.region.id] = e.value
  const data = new Uint16Array(labelMap.length)
  for (let i = 0; i < labelMap.length; i++) {
    const id = labelMap[i]
    if (id !== 0 && id <= maxId) data[i] = valueOf[id]
  }
  return { data, entries }
}

/** Binary union of the given regions' voxels (for the single-value mask). */
export function maskUnion(labelMap: Uint16Array, regions: Region[]): Uint8Array {
  const maxId = regions.reduce((m, r) => Math.max(m, r.id), 0)
  const included = new Uint8Array(maxId + 1)
  for (const r of regions) included[r.id] = 1
  const out = new Uint8Array(labelMap.length)
  for (let i = 0; i < labelMap.length; i++) {
    const id = labelMap[i]
    if (id !== 0 && id <= maxId && included[id]) out[i] = 1
  }
  return out
}

/** Plain-text color table: one "value R G B A name" row per region (TSV). */
export function buildColorTable(entries: ExportEntry[]): string {
  const lines = entries.map((e) => {
    const [r, g, b] = colorComponents(e.region.color)
    return `${e.value}\t${r}\t${g}\t${b}\t255\t${e.region.name}`
  })
  return lines.join('\n') + '\n'
}
