import type { Volume } from '../volume/types'
import { composeVoxelMap } from '../volume/affine'

/** Axis-aligned voxel box on the base grid; bounds are inclusive. */
export interface SegBox {
  min: [number, number, number]
  max: [number, number, number]
}

export function clampBox(box: SegBox, dims: [number, number, number]): SegBox {
  const min: [number, number, number] = [0, 0, 0]
  const max: [number, number, number] = [0, 0, 0]
  for (let a = 0; a < 3; a++) {
    const lo = Math.min(box.min[a], box.max[a])
    const hi = Math.max(box.min[a], box.max[a])
    min[a] = Math.min(Math.max(lo, 0), dims[a] - 1)
    max[a] = Math.min(Math.max(hi, 0), dims[a] - 1)
  }
  return { min, max }
}

/** Expand by `margin` voxels on every side (caller should re-clamp). */
export function dilatedBox(box: SegBox, margin: number): SegBox {
  return {
    min: [box.min[0] - margin, box.min[1] - margin, box.min[2] - margin],
    max: [box.max[0] + margin, box.max[1] + margin, box.max[2] + margin]
  }
}

export function wholeVolumeBox(dims: [number, number, number]): SegBox {
  return { min: [0, 0, 0], max: [dims[0] - 1, dims[1] - 1, dims[2] - 1] }
}

export function boxExtent(box: SegBox): [number, number, number] {
  return [box.max[0] - box.min[0] + 1, box.max[1] - box.min[1] + 1, box.max[2] - box.min[2] + 1]
}

export function boxVoxelCount(box: SegBox): number {
  const [w, h, d] = boxExtent(box)
  return w * h * d
}

export function boxContains(box: SegBox, i: number, j: number, k: number): boolean {
  return (
    i >= box.min[0] &&
    i <= box.max[0] &&
    j >= box.min[1] &&
    j <= box.max[1] &&
    k >= box.min[2] &&
    k <= box.max[2]
  )
}

// ---------------------------------------------------------------------------
// Constraints — lazily evaluated per voxel (global grid coordinates), so a
// grow that floods far past the box never pays for a precomputed array.

export type VoxelPredicate = (i: number, j: number, k: number) => boolean

/** Inside = the label map assigns the voxel to one region. */
export function constraintFromLabelMap(
  labelMap: Uint16Array,
  dims: [number, number, number],
  regionId: number
): VoxelPredicate {
  const sy = dims[0]
  const sz = dims[0] * dims[1]
  return (i, j, k) => labelMap[i + j * sy + k * sz] === regionId
}

/**
 * Inside = the voxel lands on a non-zero, non-NaN value of another volume
 * (nearest-neighbor through the affine pair). Null when the constraint
 * volume's affine cannot be inverted.
 */
export function constraintFromVolume(
  base: Volume,
  constraint: Volume,
  frame = 0
): VoxelPredicate | null {
  const m = composeVoxelMap(base.affine, constraint.affine)
  if (!m) return null
  const [cx, cy, cz] = constraint.dims
  const { raw, slope, inter } = constraint
  // The shared frame index, clamped to this volume's own frame count
  // (mirrors how slice display and readout sample overlays).
  const frameOff = Math.min(Math.max(frame, 0), constraint.frames - 1) * cx * cy * cz
  const m0 = m[0]
  const m1 = m[1]
  const m2 = m[2]
  const m3 = m[3]
  const m4 = m[4]
  const m5 = m[5]
  const m6 = m[6]
  const m7 = m[7]
  const m8 = m[8]
  const m9 = m[9]
  const m10 = m[10]
  const m11 = m[11]
  return (i, j, k) => {
    const xi = Math.round(m0 * i + m1 * j + m2 * k + m3)
    const yi = Math.round(m4 * i + m5 * j + m6 * k + m7)
    const zi = Math.round(m8 * i + m9 * j + m10 * k + m11)
    if (xi < 0 || xi >= cx || yi < 0 || yi >= cy || zi < 0 || zi >= cz) return false
    const v = raw[frameOff + xi + yi * cx + zi * cx * cy] * slope + inter
    return v !== 0 && !Number.isNaN(v)
  }
}

// ---------------------------------------------------------------------------
// Fixed calibrated-value tuning constants, independent of the image
// histogram. The sliders, the auto-threshold clamps, and the method-switch
// clamps all read these.

/** Range the plain threshold is tuned in. */
export const THRESHOLD_RANGE: [number, number] = [40, 100]
/** Initial threshold / grow boundary. */
export const THRESHOLD_DEFAULT = 55
/** Range the grow boundary (grow-to level) is tuned in. */
export const GROW_BOUNDARY_RANGE: [number, number] = [40, 80]
/** Range the grow seed level is tuned in. */
export const GROW_SEED_RANGE: [number, number] = [40, 2000]
/** Seed level used when the box has no usable voxels. */
export const GROW_SEED_DEFAULT = 300
/** Fallback for automatic thresholds over an empty/degenerate box. */
export const AUTO_THRESHOLD_FALLBACK = 130
/** Automatic thresholds are never returned below this floor (so they split
 * the bright structure from its dimmer surround, not signal from background)
 * nor above this ceiling. */
export const OTSU_FLOOR = 80
export const OTSU_CEILING = 2000

export function clampTo(v: number, range: [number, number]): number {
  return Math.min(Math.max(v, range[0]), range[1])
}

// ---------------------------------------------------------------------------
// Box statistics

export interface BoxStats {
  min: number
  max: number
  mean: number
  /** In-box voxels that passed the constraint (0 = stats are placeholders). */
  count: number
}

/** Scaled-intensity min/max/mean over the box ∩ constraint (one pass). */
export function boxStats(
  vol: Volume,
  box: SegBox,
  frameOffset = 0,
  constraint: VoxelPredicate | null = null
): BoxStats {
  const [nx, ny] = vol.dims
  const { raw, slope, inter } = vol
  let min = Infinity
  let max = -Infinity
  let sum = 0
  let n = 0
  for (let k = box.min[2]; k <= box.max[2]; k++) {
    for (let j = box.min[1]; j <= box.max[1]; j++) {
      let idx = frameOffset + box.min[0] + j * nx + k * nx * ny
      for (let i = box.min[0]; i <= box.max[0]; i++, idx++) {
        if (constraint && !constraint(i, j, k)) continue
        const v = raw[idx] * slope + inter
        if (Number.isNaN(v)) continue
        if (v < min) min = v
        if (v > max) max = v
        sum += v
        n++
      }
    }
  }
  if (n === 0) return { min: 0, max: 0, mean: 0, count: 0 }
  return { min, max, mean: sum / n, count: n }
}

export interface HistogramResult {
  counts: Uint32Array
  /** Scaled-intensity range the bins span (0/0 when the box has no voxels). */
  min: number
  max: number
}

/** Intensity histogram over the box ∩ constraint (for the panel and Otsu). */
export function boxHistogram(
  vol: Volume,
  box: SegBox,
  bins: number,
  frameOffset = 0,
  constraint: VoxelPredicate | null = null
): HistogramResult {
  const stats = boxStats(vol, box, frameOffset, constraint)
  const counts = new Uint32Array(bins)
  if (stats.count === 0) return { counts, min: 0, max: 0 }
  const min = stats.min
  const max = stats.max > min ? stats.max : min + 1
  const scale = bins / (max - min)
  const [nx, ny] = vol.dims
  const { raw, slope, inter } = vol
  for (let k = box.min[2]; k <= box.max[2]; k++) {
    for (let j = box.min[1]; j <= box.max[1]; j++) {
      let idx = frameOffset + box.min[0] + j * nx + k * nx * ny
      for (let i = box.min[0]; i <= box.max[0]; i++, idx++) {
        if (constraint && !constraint(i, j, k)) continue
        const v = raw[idx] * slope + inter
        if (Number.isNaN(v)) continue
        let b = ((v - min) * scale) | 0
        b = b >= bins ? bins - 1 : b < 0 ? 0 : b
        counts[b]++
      }
    }
  }
  return { counts, min, max }
}

/**
 * Otsu's method over a 256-bin histogram of the box ∩ constraint. A clean
 * bimodal histogram has an empty gap between the two modes, and every split
 * bin inside the gap yields the same maximal between-class variance — so the
 * full plateau of (near-)maximal bins is tracked and its midpoint returned,
 * landing the threshold in the middle of the gap instead of hugging the lower
 * mode. The result is clamped to [OTSU_FLOOR, OTSU_CEILING]; degenerate boxes
 * fall back to AUTO_THRESHOLD_FALLBACK.
 */
export function otsuThreshold(
  vol: Volume,
  box: SegBox,
  frameOffset = 0,
  constraint: VoxelPredicate | null = null
): number {
  const BINS = 256
  const { counts, min, max } = boxHistogram(vol, box, BINS, frameOffset, constraint)
  let total = 0
  let occupied = 0
  for (let b = 0; b < BINS; b++) {
    total += counts[b]
    if (counts[b] > 0) occupied++
  }
  // Empty or single-valued box: no split exists.
  if (total === 0 || max <= min || occupied < 2) return AUTO_THRESHOLD_FALLBACK

  let sumAll = 0
  for (let b = 0; b < BINS; b++) sumAll += b * counts[b]
  let wBg = 0
  let sumBg = 0
  let bestVar = -1
  let firstBest = BINS / 2
  let lastBest = BINS / 2
  for (let b = 0; b < BINS; b++) {
    wBg += counts[b]
    if (wBg === 0) continue
    const wFg = total - wBg
    if (wFg === 0) break
    sumBg += b * counts[b]
    const mBg = sumBg / wBg
    const mFg = (sumAll - sumBg) / wFg
    const between = (wBg / total) * (wFg / total) * (mBg - mFg) * (mBg - mFg)
    if (between > bestVar * (1 + 1e-12) || bestVar < 0) {
      bestVar = between
      firstBest = b
      lastBest = b
    } else if (between >= bestVar * (1 - 1e-12)) {
      lastBest = b
    }
  }
  const mid = Math.floor((firstBest + lastBest) / 2)
  const threshold = min + ((mid + 0.5) / BINS) * (max - min)
  return clampTo(threshold, [OTSU_FLOOR, OTSU_CEILING])
}

// ---------------------------------------------------------------------------
// The unified engine: hysteresis + 3D-connected-component region growing.
//
//   • Threshold-in-box collapses to high == low, seeds = the whole box, and
//     bounds = the box: every box voxel at/above the threshold, grouped into
//     connected components and size-filtered.
//   • Grow-from-seed uses high > low: the box is entirely region, its
//     confident ≥high interior seeds a flood that extends past the box down
//     to the ≥low boundary — robust to a fuzzy partial-intensity rim.

export type Connectivity = 6 | 26

export interface EngineParams {
  /** Boundary / grow-to threshold; candidates need v >= low. */
  low: number
  /** Seed threshold; seeds need v >= high (== low for plain thresholding). */
  high: number
  connectivity: Connectivity
  /** Connected components smaller than this are dropped (speck removal). */
  minVoxels: number
  /** Safety cap on visited voxels (runaway unbounded grow). */
  maxVoxels?: number
}

export interface SegmentResult {
  /** Selected voxels as a binary mask over `bounds`. */
  mask: Uint8Array
  bounds: SegBox
  voxels: number
  /** Connected components surviving the size filter. */
  components: number
  /** True when the safety cap stopped a runaway grow. */
  truncated: boolean
}

/** Default cap on a single grow's visited voxels. */
export const MAX_RESULT_VOXELS = 5_000_000

function neighborOffsets(connectivity: Connectivity): [Int8Array, Int8Array, Int8Array] {
  if (connectivity === 6) {
    return [
      Int8Array.from([1, -1, 0, 0, 0, 0]),
      Int8Array.from([0, 0, 1, -1, 0, 0]),
      Int8Array.from([0, 0, 0, 0, 1, -1])
    ]
  }
  const dx: number[] = []
  const dy: number[] = []
  const dz: number[] = []
  for (let z = -1; z <= 1; z++) {
    for (let y = -1; y <= 1; y++) {
      for (let x = -1; x <= 1; x++) {
        if (x === 0 && y === 0 && z === 0) continue
        dx.push(x)
        dy.push(y)
        dz.push(z)
      }
    }
  }
  return [Int8Array.from(dx), Int8Array.from(dy), Int8Array.from(dz)]
}

class IntStack {
  buf = new Int32Array(1024)
  top = 0

  push(v: number): void {
    if (this.top === this.buf.length) {
      const next = new Int32Array(this.buf.length * 2)
      next.set(this.buf)
      this.buf = next
    }
    this.buf[this.top++] = v
  }

  pop(): number {
    return this.buf[--this.top]
  }
}

/** Open-addressed int set for the sparse flood path (keys >= 0, -1 = empty). */
class IntHashSet {
  private table = new Int32Array(1 << 12).fill(-1)
  size = 0

  private slot(k: number): number {
    // Fibonacci hashing; the table length is always a power of two.
    let i = (Math.imul(k, 0x9e3779b1) >>> 0) & (this.table.length - 1)
    while (this.table[i] !== -1 && this.table[i] !== k) i = (i + 1) & (this.table.length - 1)
    return i
  }

  has(k: number): boolean {
    return this.table[this.slot(k)] === k
  }

  add(k: number): void {
    if ((this.size + 1) * 2 > this.table.length) this.grow()
    const i = this.slot(k)
    if (this.table[i] === k) return
    this.table[i] = k
    this.size++
  }

  private grow(): void {
    const old = this.table
    this.table = new Int32Array(old.length * 2).fill(-1)
    for (let i = 0; i < old.length; i++) {
      if (old[i] !== -1) this.table[this.slot(old[i])] = old[i]
    }
  }
}

/** Dense per-bounds arrays cost 2 bytes/voxel; when bounds exceed the visit
 * cap by this factor the sparse path is cheaper (and whole-volume bounds on
 * a large file would otherwise allocate GBs just to preview a grow). */
const SPARSE_BOUNDS_FACTOR = 4

/**
 * Capped flood over bounds far larger than the cap can ever visit: visited
 * voxels live in a hash set instead of a bounds-sized array, and the mask is
 * emitted over the tight bounding box of the result. Memory scales with the
 * cap, not the volume.
 */
function segmentRegionSparse(
  vol: Volume,
  seedBox: SegBox,
  bounds: SegBox,
  params: EngineParams,
  frameOffset: number,
  constraint: VoxelPredicate | null
): SegmentResult {
  const [dxs, dys, dzs] = neighborOffsets(params.connectivity)
  const nOff = dxs.length
  const low = Math.min(params.low, params.high)
  const high = Math.max(params.low, params.high)
  const minSize = Math.max(1, params.minVoxels)
  const maxVoxels = params.maxVoxels ?? MAX_RESULT_VOXELS

  const [nx, ny] = vol.dims
  const nxy = nx * ny
  const { raw, slope, inter } = vol

  const visited = new IntHashSet()
  const stack = new IntStack()
  const component = new IntStack()
  const selected = new IntStack()
  let voxels = 0
  let components = 0
  let truncated = false

  const keepComponent = (): void => {
    for (let s = 0; s < component.top; s++) selected.push(component.buf[s])
    voxels += component.top
    components++
  }

  outer: for (let k = seedBox.min[2]; k <= seedBox.max[2]; k++) {
    for (let j = seedBox.min[1]; j <= seedBox.max[1]; j++) {
      let g = seedBox.min[0] + j * nx + k * nxy
      for (let i = seedBox.min[0]; i <= seedBox.max[0]; i++, g++) {
        if (visited.has(g)) continue
        // Negated form so NaN never seeds (it fails every comparison).
        if (!(raw[frameOffset + g] * slope + inter >= high)) continue
        if (constraint && !constraint(i, j, k)) continue

        component.top = 0
        visited.add(g)
        stack.top = 0
        stack.push(g)
        while (stack.top > 0) {
          const c = stack.pop()
          component.push(c)
          const li = c % nx
          const lj = ((c / nx) | 0) % ny
          const lk = (c / nxy) | 0
          for (let o = 0; o < nOff; o++) {
            const mi = li + dxs[o]
            const mj = lj + dys[o]
            const mk = lk + dzs[o]
            if (
              mi < bounds.min[0] ||
              mi > bounds.max[0] ||
              mj < bounds.min[1] ||
              mj > bounds.max[1] ||
              mk < bounds.min[2] ||
              mk > bounds.max[2]
            ) {
              continue
            }
            const q = mi + mj * nx + mk * nxy
            if (visited.has(q)) continue
            const v = raw[frameOffset + q] * slope + inter
            if (!(v >= low)) continue
            if (constraint && !constraint(mi, mj, mk)) continue
            visited.add(q)
            stack.push(q)
          }
          if (visited.size > maxVoxels) {
            truncated = true
            break
          }
        }

        if (truncated) {
          // Keep what the capped flood reached (plus what is still queued),
          // so the preview shows where the runaway went.
          while (stack.top > 0) component.push(stack.pop())
          keepComponent()
          break outer
        }
        if (component.top >= minSize) keepComponent()
      }
    }
  }

  if (selected.top === 0) {
    return {
      mask: new Uint8Array(1),
      bounds: {
        min: [seedBox.min[0], seedBox.min[1], seedBox.min[2]],
        max: [seedBox.min[0], seedBox.min[1], seedBox.min[2]]
      },
      voxels: 0,
      components,
      truncated
    }
  }

  // Emit the mask over the tight bounding box of the kept voxels.
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let s = 0; s < selected.top; s++) {
    const c = selected.buf[s]
    const li = c % nx
    const lj = ((c / nx) | 0) % ny
    const lk = (c / nxy) | 0
    if (li < min[0]) min[0] = li
    if (li > max[0]) max[0] = li
    if (lj < min[1]) min[1] = lj
    if (lj > max[1]) max[1] = lj
    if (lk < min[2]) min[2] = lk
    if (lk > max[2]) max[2] = lk
  }
  const outBounds: SegBox = { min, max }
  const [bw, bh] = boxExtent(outBounds)
  const mask = new Uint8Array(boxVoxelCount(outBounds))
  for (let s = 0; s < selected.top; s++) {
    const c = selected.buf[s]
    const li = c % nx
    const lj = ((c / nx) | 0) % ny
    const lk = (c / nxy) | 0
    mask[li - min[0] + (lj - min[1]) * bw + (lk - min[2]) * bw * bh] = 1
  }
  return { mask, bounds: outBounds, voxels, components, truncated }
}

/**
 * Non-mutating hot path for the live preview: flood every component seeded
 * from `seedBox` (v >= high) over candidates (v >= low, inside `bounds`,
 * inside the constraint), drop components below minVoxels, and return the
 * kept voxels as a mask over the result's `bounds`. Both boxes must be
 * pre-clamped and bounds must contain seedBox. Bounds that dwarf a finite
 * visit cap route to the sparse path (tight result bounds, memory bounded by
 * the cap instead of the volume).
 */
export function segmentRegion(
  vol: Volume,
  seedBox: SegBox,
  bounds: SegBox,
  params: EngineParams,
  frameOffset = 0,
  constraint: VoxelPredicate | null = null
): SegmentResult {
  const [bw, bh, bd] = boxExtent(bounds)
  const n = boxVoxelCount(bounds)
  const cap = params.maxVoxels ?? MAX_RESULT_VOXELS
  if (Number.isFinite(cap) && n > cap * SPARSE_BOUNDS_FACTOR) {
    return segmentRegionSparse(vol, seedBox, bounds, params, frameOffset, constraint)
  }
  const visited = new Uint8Array(n)
  const mask = new Uint8Array(n)
  const [dxs, dys, dzs] = neighborOffsets(params.connectivity)
  const nOff = dxs.length
  const low = Math.min(params.low, params.high)
  const high = Math.max(params.low, params.high)
  const minSize = Math.max(1, params.minVoxels)
  const maxVoxels = params.maxVoxels ?? MAX_RESULT_VOXELS

  const [nx, ny] = vol.dims
  const { raw, slope, inter } = vol
  const [ox, oy, oz] = bounds.min
  const bhw = bw * bh

  const stack = new IntStack()
  const component = new IntStack()
  let visitedCount = 0
  let voxels = 0
  let components = 0
  let truncated = false

  const keepComponent = (): void => {
    for (let s = 0; s < component.top; s++) mask[component.buf[s]] = 1
    voxels += component.top
    components++
  }

  outer: for (let k = seedBox.min[2]; k <= seedBox.max[2]; k++) {
    for (let j = seedBox.min[1]; j <= seedBox.max[1]; j++) {
      let gIdx = frameOffset + seedBox.min[0] + j * nx + k * nx * ny
      for (let i = seedBox.min[0]; i <= seedBox.max[0]; i++, gIdx++) {
        const p = i - ox + (j - oy) * bw + (k - oz) * bhw
        if (visited[p]) continue
        // Negated form so NaN never seeds (it fails every comparison).
        if (!(raw[gIdx] * slope + inter >= high)) continue
        if (constraint && !constraint(i, j, k)) continue

        // Flood this component over candidates (region growing).
        component.top = 0
        visited[p] = 1
        visitedCount++
        stack.top = 0
        stack.push(p)
        while (stack.top > 0) {
          const c = stack.pop()
          component.push(c)
          const li = c % bw
          const lj = ((c / bw) | 0) % bh
          const lk = (c / bhw) | 0
          for (let o = 0; o < nOff; o++) {
            const mi = li + dxs[o]
            const mj = lj + dys[o]
            const mk = lk + dzs[o]
            if (mi < 0 || mi >= bw || mj < 0 || mj >= bh || mk < 0 || mk >= bd) continue
            const q = mi + mj * bw + mk * bhw
            if (visited[q]) continue
            const gi = mi + ox
            const gj = mj + oy
            const gk = mk + oz
            const v = raw[frameOffset + gi + gj * nx + gk * nx * ny] * slope + inter
            if (!(v >= low)) continue
            if (constraint && !constraint(gi, gj, gk)) continue
            visited[q] = 1
            visitedCount++
            stack.push(q)
          }
          if (visitedCount > maxVoxels) {
            truncated = true
            break
          }
        }

        if (truncated) {
          // Keep what the capped flood reached (plus what is still queued),
          // so the preview shows where the runaway went.
          while (stack.top > 0) component.push(stack.pop())
          keepComponent()
          break outer
        }
        if (component.top >= minSize) keepComponent()
      }
    }
  }

  return { mask, bounds, voxels, components, truncated }
}

export function countMask(mask: Uint8Array): number {
  let n = 0
  for (let i = 0; i < mask.length; i++) if (mask[i] !== 0) n++
  return n
}
