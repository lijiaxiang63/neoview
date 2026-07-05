import type { TransformSource } from './types'

export interface AffineInput {
  sformCode: number
  qformCode: number
  srow: [Float64Array, Float64Array, Float64Array]
  quatern: [number, number, number]
  qoffset: [number, number, number]
  /** Sign carrier from pixdim[0]: negative flips the third rotation column. */
  qfacRaw: number
  spacing: [number, number, number]
}

export interface AffineResult {
  m: Float64Array
  source: TransformSource
}

export function buildAffine(input: AffineInput): AffineResult {
  const m = new Float64Array(16)
  m[15] = 1

  if (input.sformCode > 0) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        m[r * 4 + c] = input.srow[r][c]
      }
    }
    return { m, source: 'rows' }
  }

  if (input.qformCode > 0) {
    const [b, c, d] = input.quatern
    const a = Math.sqrt(Math.max(0, 1 - b * b - c * c - d * d))
    const qfac = input.qfacRaw < 0 ? -1 : 1
    const R = [
      a * a + b * b - c * c - d * d,
      2 * (b * c - a * d),
      2 * (b * d + a * c),
      2 * (b * c + a * d),
      a * a + c * c - b * b - d * d,
      2 * (c * d - a * b),
      2 * (b * d - a * c),
      2 * (c * d + a * b),
      a * a + d * d - b * b - c * c
    ]
    const colScale = [input.spacing[0], input.spacing[1], input.spacing[2] * qfac]
    for (let r = 0; r < 3; r++) {
      for (let col = 0; col < 3; col++) {
        m[r * 4 + col] = R[r * 3 + col] * colScale[col]
      }
      m[r * 4 + 3] = input.qoffset[r]
    }
    return { m, source: 'quaternion' }
  }

  m[0] = input.spacing[0]
  m[5] = input.spacing[1]
  m[10] = input.spacing[2]
  return { m, source: 'spacing-fallback' }
}

export function applyAffine(
  m: Float64Array,
  i: number,
  j: number,
  k: number
): [number, number, number] {
  return [
    m[0] * i + m[1] * j + m[2] * k + m[3],
    m[4] * i + m[5] * j + m[6] * k + m[7],
    m[8] * i + m[9] * j + m[10] * k + m[11]
  ]
}

/**
 * Invert a row-major 4x4 affine whose last row is 0 0 0 1 (as buildAffine
 * guarantees): adjugate inverse of the upper 3x3, then t' = -R⁻¹·t.
 * Returns null when the upper 3x3 is singular.
 */
export function invertAffine(m: Float64Array): Float64Array | null {
  const c00 = m[5] * m[10] - m[6] * m[9]
  const c01 = m[6] * m[8] - m[4] * m[10]
  const c02 = m[4] * m[9] - m[5] * m[8]
  const det = m[0] * c00 + m[1] * c01 + m[2] * c02
  if (Math.abs(det) < 1e-12) return null
  const inv = new Float64Array(16)
  inv[0] = c00 / det
  inv[1] = (m[2] * m[9] - m[1] * m[10]) / det
  inv[2] = (m[1] * m[6] - m[2] * m[5]) / det
  inv[4] = c01 / det
  inv[5] = (m[0] * m[10] - m[2] * m[8]) / det
  inv[6] = (m[2] * m[4] - m[0] * m[6]) / det
  inv[8] = c02 / det
  inv[9] = (m[1] * m[8] - m[0] * m[9]) / det
  inv[10] = (m[0] * m[5] - m[1] * m[4]) / det
  inv[3] = -(inv[0] * m[3] + inv[1] * m[7] + inv[2] * m[11])
  inv[7] = -(inv[4] * m[3] + inv[5] * m[7] + inv[6] * m[11])
  inv[11] = -(inv[8] * m[3] + inv[9] * m[7] + inv[10] * m[11])
  inv[15] = 1
  return inv
}

/** Multiply two row-major 4x4 matrices: returns a·b. */
export function multiplyAffine(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(16)
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r * 4 + c] =
        a[r * 4] * b[c] +
        a[r * 4 + 1] * b[4 + c] +
        a[r * 4 + 2] * b[8 + c] +
        a[r * 4 + 3] * b[12 + c]
    }
  }
  return out
}

/**
 * Voxel-to-voxel map from the base grid to an overlay grid:
 * M = inv(overlayAffine) · baseAffine. Null when overlayAffine is singular.
 */
export function composeVoxelMap(
  baseAffine: Float64Array,
  overlayAffine: Float64Array
): Float64Array | null {
  const inv = invertAffine(overlayAffine)
  return inv ? multiplyAffine(inv, baseAffine) : null
}
