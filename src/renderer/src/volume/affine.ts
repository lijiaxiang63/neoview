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
