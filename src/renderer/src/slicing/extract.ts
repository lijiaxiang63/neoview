import type { Volume } from '../volume/types'

export interface PlaneSpec {
  sliceAxis: 0 | 1 | 2
  colAxis: 0 | 1 | 2
  rowAxis: 0 | 1 | 2
  label: string
}

export const PLANES: readonly PlaneSpec[] = [
  { sliceAxis: 2, colAxis: 0, rowAxis: 1, label: 'Plane XY' },
  { sliceAxis: 1, colAxis: 0, rowAxis: 2, label: 'Plane XZ' },
  { sliceAxis: 0, colAxis: 1, rowAxis: 2, label: 'Plane YZ' }
]

export const AXIS_NAMES = ['i', 'j', 'k'] as const

export function strides(dims: [number, number, number]): [number, number, number] {
  return [1, dims[0], dims[0] * dims[1]]
}

/**
 * Extract one slice into an ImageData buffer, mapping intensity through the
 * display range [lo, hi]. Rows are written bottom-up so the row axis
 * increases upward on screen.
 */
export function extractSliceToImageData(
  vol: Volume,
  plane: PlaneSpec,
  sliceIdx: number,
  frame: number,
  lo: number,
  hi: number,
  img: ImageData
): void {
  const { raw, slope, inter, dims } = vol
  const stride = strides(dims)
  const cs = stride[plane.colAxis]
  const rs = stride[plane.rowAxis]
  const frameStride = dims[0] * dims[1] * dims[2]
  const base = sliceIdx * stride[plane.sliceAxis] + frame * frameStride
  const w = dims[plane.colAxis]
  const h = dims[plane.rowAxis]
  const scale = 255 / Math.max(hi - lo, 1e-12)
  const px = new Uint32Array(img.data.buffer)
  let p = 0
  for (let r = h - 1; r >= 0; r--) {
    let idx = base + r * rs
    for (let c = 0; c < w; c++, idx += cs, p++) {
      let v = (raw[idx] * slope + inter - lo) * scale
      v = v < 0 ? 0 : v > 255 ? 255 : v | 0
      px[p] = 0xff000000 | (v << 16) | (v << 8) | v
    }
  }
}
