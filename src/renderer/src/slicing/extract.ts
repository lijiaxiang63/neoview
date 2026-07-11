import type { Volume } from '../volume/types'

export interface PlaneSpec {
  sliceAxis: 0 | 1 | 2
  colAxis: 0 | 1 | 2
  rowAxis: 0 | 1 | 2
  /** Raw-axis direction from the left edge toward the right edge. */
  colDirection: 1 | -1
  /** Raw-axis direction from the bottom edge toward the top edge. */
  rowDirection: 1 | -1
  label: string
}

export const PLANES: readonly PlaneSpec[] = [
  { sliceAxis: 2, colAxis: 0, rowAxis: 1, colDirection: 1, rowDirection: 1, label: 'Plane XY' },
  { sliceAxis: 1, colAxis: 0, rowAxis: 2, colDirection: 1, rowDirection: 1, label: 'Plane XZ' },
  { sliceAxis: 0, colAxis: 1, rowAxis: 2, colDirection: 1, rowDirection: 1, label: 'Plane YZ' }
]

export function strides(dims: [number, number, number]): [number, number, number] {
  return [1, dims[0], dims[0] * dims[1]]
}

/**
 * Extract one slice into an ImageData buffer, mapping intensity through the
 * display range [lo, hi]. The plane directions determine which raw edge is
 * displayed at each screen edge. `lut` (256 packed RGBA entries) recolors the
 * windowed intensity; null keeps the grayscale fast path.
 */
export function extractSliceToImageData(
  vol: Volume,
  plane: PlaneSpec,
  sliceIdx: number,
  frame: number,
  lo: number,
  hi: number,
  img: ImageData,
  lut: Uint32Array | null = null
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
  const colStart = plane.colDirection > 0 ? 0 : w - 1
  const rowStart = plane.rowDirection > 0 ? h - 1 : 0
  const colStep = cs * plane.colDirection
  const rowStep = -plane.rowDirection
  let p = 0
  if (lut) {
    for (let screenRow = 0, r = rowStart; screenRow < h; screenRow++, r += rowStep) {
      let idx = base + r * rs + colStart * cs
      for (let c = 0; c < w; c++, idx += colStep, p++) {
        let v = (raw[idx] * slope + inter - lo) * scale
        v = v < 0 ? 0 : v > 255 ? 255 : v | 0
        px[p] = lut[v]
      }
    }
    return
  }
  for (let screenRow = 0, r = rowStart; screenRow < h; screenRow++, r += rowStep) {
    let idx = base + r * rs + colStart * cs
    for (let c = 0; c < w; c++, idx += colStep, p++) {
      let v = (raw[idx] * slope + inter - lo) * scale
      v = v < 0 ? 0 : v > 255 ? 255 : v | 0
      px[p] = 0xff000000 | (v << 16) | (v << 8) | v
    }
  }
}
