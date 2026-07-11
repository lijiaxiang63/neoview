import type { Volume } from '../volume/types'

/**
 * Fill `out` (or a fresh Float32Array) with one frame of the volume,
 * value-scaled and normalized to [0, 1] over the volume's scaled data range.
 * This single representation feeds the 3D texture for every input datatype;
 * display-range windowing happens later in the shader.
 */
export function normalizeFrame(vol: Volume, frame: number, out?: Float32Array): Float32Array {
  const n = vol.dims[0] * vol.dims[1] * vol.dims[2]
  const dst = out && out.length === n ? out : new Float32Array(n)
  const { raw, slope, inter, stats } = vol
  const span = Math.max(stats.dataMax - stats.dataMin, 1e-12)
  const lo = stats.dataMin
  const off = frame * n
  for (let i = 0; i < n; i++) {
    const v = (raw[off + i] * slope + inter - lo) / span
    dst[i] = Number.isFinite(v) ? v : 0
  }
  return dst
}

/** Convert a display-range bound in scaled units to normalized texture space. */
export function scaledToNormalized(vol: Volume, v: number): number {
  const span = Math.max(vol.stats.dataMax - vol.stats.dataMin, 1e-12)
  return (v - vol.stats.dataMin) / span
}

/**
 * Half-extents of the volume's box in render space: physical size per axis
 * (dims * spacing) normalized so the longest axis spans [-0.5, 0.5].
 * Anisotropic spacing enters the raycaster only through this value.
 */
export function halfExtents(
  dims: [number, number, number],
  spacing: [number, number, number]
): [number, number, number] {
  const phys = [dims[0] * spacing[0], dims[1] * spacing[1], dims[2] * spacing[2]]
  const m = Math.max(phys[0], phys[1], phys[2], 1e-12)
  return [(0.5 * phys[0]) / m, (0.5 * phys[1]) / m, (0.5 * phys[2]) / m]
}

/** Voxel budget for the 3D texture; larger volumes are stride-downsampled. */
export const MAX_TEX_VOXELS = 128 * 2 ** 20

export interface TexPlan {
  stride: [number, number, number]
  texDims: [number, number, number]
  /** Effective spacing after striding — physical extents stay identical. */
  texSpacing: [number, number, number]
}

/**
 * Choose per-axis strides so the 3D texture stays under the voxel budget.
 * The slice views keep full resolution; only the raycaster's texture shrinks.
 */
export function planTexture(
  dims: [number, number, number],
  spacing: [number, number, number],
  maxVoxels = MAX_TEX_VOXELS
): TexPlan {
  const stride: [number, number, number] = [1, 1, 1]
  const texDims: [number, number, number] = [...dims]
  while (texDims[0] * texDims[1] * texDims[2] > maxVoxels) {
    // Halve the currently largest axis to keep sampling roughly isotropic.
    let axis = 0
    if (texDims[1] >= texDims[axis]) axis = 1
    if (texDims[2] >= texDims[axis]) axis = 2
    stride[axis] *= 2
    texDims[axis] = Math.ceil(dims[axis] / stride[axis])
  }
  return {
    stride,
    texDims,
    // Derived from the ORIGINAL physical extent, not spacing*stride: when an
    // axis is not divisible by its stride, the rounded-up texel count would
    // otherwise pad the rendered box by up to stride-1 voxels and misalign
    // the 3D view against the (full-resolution) slice views.
    texSpacing: [
      (dims[0] * spacing[0]) / texDims[0],
      (dims[1] * spacing[1]) / texDims[1],
      (dims[2] * spacing[2]) / texDims[2]
    ]
  }
}

/**
 * Downsample the region label map onto the 3D texture grid (the same plan as
 * the base texture, so both stay aligned): one byte per texel carrying a
 * palette index, 0 = no region. `indexOf` maps region id → palette index;
 * ids at/behind its length map to 0.
 */
export function buildLabelTexData(
  labelMap: Uint16Array,
  dims: [number, number, number],
  plan: TexPlan,
  indexOf: Uint8Array,
  out?: Uint8Array
): Uint8Array {
  const [nx, ny, nz] = dims
  const [tx, ty, tz] = plan.texDims
  const [sx, sy, sz] = plan.stride
  const count = tx * ty * tz
  const dst = out && out.length === count ? out : new Uint8Array(count)
  if (sx === 1 && sy === 1 && sz === 1) {
    // Unit stride (the common, under-budget case): texel = voxel.
    for (let i = 0; i < count; i++) {
      const id = labelMap[i]
      dst[i] = id < indexOf.length ? indexOf[id] : 0
    }
    return dst
  }
  // Strided: each texel covers an sx×sy×sz source block (edge-clipped). A
  // point sample would drop any region thinner than the stride from the 3D
  // view, so scan the block for a voxel with a visible palette index. Total
  // work is one pass over the label map, the same as the unit-stride case.
  let p = 0
  for (let k = 0; k < tz; k++) {
    const z0 = k * sz
    const z1 = Math.min(z0 + sz, nz)
    for (let j = 0; j < ty; j++) {
      const y0 = j * sy
      const y1 = Math.min(y0 + sy, ny)
      for (let i = 0; i < tx; i++, p++) {
        const x0 = i * sx
        const x1 = Math.min(x0 + sx, nx)
        let v = 0
        scan: for (let z = z0; z < z1; z++) {
          for (let y = y0; y < y1; y++) {
            let idx = (z * ny + y) * nx + x0
            for (let x = x0; x < x1; x++, idx++) {
              const id = labelMap[idx]
              if (id !== 0 && id < indexOf.length && indexOf[id] !== 0) {
                v = indexOf[id]
                break scan
              }
            }
          }
        }
        dst[p] = v
      }
    }
  }
  return dst
}

const f32Scratch = new Float32Array(1)
const u32Scratch = new Uint32Array(f32Scratch.buffer)

/** IEEE half-float bits for a finite float (truncating mantissa; display-grade). */
export function floatToHalf(v: number): number {
  f32Scratch[0] = v
  const x = u32Scratch[0]
  const sign = (x >>> 16) & 0x8000
  const exp = (x >>> 23) & 0xff
  let mant = x & 0x7fffff
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 1 : 0)
  const e = exp - 127 + 15
  if (e >= 0x1f) return sign | 0x7c00
  if (e <= 0) {
    if (e < -10) return sign
    mant |= 0x800000
    return sign | (mant >> (14 - e))
  }
  return sign | (e << 10) | (mant >> 13)
}

/**
 * Build the 3D texture payload for one frame in a single fused pass:
 * stride sampling + value scaling + [0,1] normalization + half-float packing.
 * Runs in the load worker for frame 0 and on demand for 4D frame changes.
 */
export function buildTexData(
  vol: Volume,
  frame: number,
  plan: TexPlan,
  out?: Uint16Array
): Uint16Array {
  const [nx, ny] = [vol.dims[0], vol.dims[1]]
  const [tx, ty, tz] = plan.texDims
  const [sx, sy, sz] = plan.stride
  const count = tx * ty * tz
  const dst = out && out.length === count ? out : new Uint16Array(count)
  const { raw, slope, inter, stats } = vol
  const span = Math.max(stats.dataMax - stats.dataMin, 1e-12)
  const lo = stats.dataMin
  const frameOff = frame * nx * ny * vol.dims[2]
  let p = 0
  for (let k = 0; k < tz; k++) {
    const kOff = frameOff + k * sz * nx * ny
    for (let j = 0; j < ty; j++) {
      let idx = kOff + j * sy * nx
      for (let i = 0; i < tx; i++, idx += sx, p++) {
        const v = (raw[idx] * slope + inter - lo) / span
        dst[p] = floatToHalf(Number.isFinite(v) ? v : 0)
      }
    }
  }
  return dst
}

export interface CooperativeTextureOptions {
  /** Stop an obsolete target before doing another chunk. */
  cancelled(): boolean
  /** Yield to input/rendering between bounded chunks. */
  yieldControl(): Promise<void>
  chunkTexels?: number
}

/** Large non-shared frames cannot be transferred to a worker without first
 * copying the whole frame on the UI thread. Build only the bounded texture
 * output instead, yielding between chunks so input and paint work can run;
 * a newer target can cancel at every yield without retaining a frame copy. */
export async function buildTexDataCooperative(
  vol: Volume,
  frame: number,
  plan: TexPlan,
  options: CooperativeTextureOptions
): Promise<Uint16Array | null> {
  if (options.cancelled()) return null
  const [nx, ny] = [vol.dims[0], vol.dims[1]]
  const [tx, ty, tz] = plan.texDims
  const [sx, sy, sz] = plan.stride
  const count = tx * ty * tz
  const dst = new Uint16Array(count)
  const { raw, slope, inter, stats } = vol
  const span = Math.max(stats.dataMax - stats.dataMin, 1e-12)
  const lo = stats.dataMin
  const frameOff = frame * nx * ny * vol.dims[2]
  const chunkTexels = Math.max(1, Math.floor(options.chunkTexels ?? 262_144))
  let chunk = 0
  let p = 0
  for (let k = 0; k < tz; k++) {
    const kOff = frameOff + k * sz * nx * ny
    for (let j = 0; j < ty; j++) {
      let idx = kOff + j * sy * nx
      for (let i = 0; i < tx; i++, idx += sx, p++) {
        const v = (raw[idx] * slope + inter - lo) / span
        dst[p] = floatToHalf(Number.isFinite(v) ? v : 0)
        chunk++
        if (chunk < chunkTexels || p + 1 === count) continue
        if (options.cancelled()) return null
        chunk = 0
        await options.yieldControl()
        if (options.cancelled()) return null
      }
    }
  }
  return dst
}
