import { describe, expect, it } from 'vitest'
import { applyAffine, buildAffine, type AffineInput } from '../src/renderer/src/volume/affine'

const base = (): AffineInput => ({
  sformCode: 0,
  qformCode: 0,
  srow: [new Float64Array(4), new Float64Array(4), new Float64Array(4)],
  quatern: [0, 0, 0],
  qoffset: [0, 0, 0],
  qfacRaw: 1,
  spacing: [1, 1, 1]
})

describe('buildAffine', () => {
  it('falls back to spacing diagonal', () => {
    const input = base()
    input.spacing = [2, 3, 4]
    const { m, source } = buildAffine(input)
    expect(source).toBe('spacing-fallback')
    expect(applyAffine(m, 1, 1, 1)).toEqual([2, 3, 4])
  })

  it('prefers matrix rows over quaternion', () => {
    const input = base()
    input.sformCode = 1
    input.qformCode = 1
    input.srow[0].set([1, 0, 0, 10])
    input.srow[1].set([0, 1, 0, 20])
    input.srow[2].set([0, 0, 1, 30])
    input.quatern = [1, 0, 0] // would be a 180-degree rotation if used
    const { m, source } = buildAffine(input)
    expect(source).toBe('rows')
    expect(applyAffine(m, 5, 6, 7)).toEqual([15, 26, 37])
  })

  it('identity quaternion equals spacing diagonal plus offset', () => {
    const input = base()
    input.qformCode = 1
    input.spacing = [1, 1, 2.5]
    input.qoffset = [-32, -32, -50]
    const { m, source } = buildAffine(input)
    expect(source).toBe('quaternion')
    expect(applyAffine(m, 10, 20, 30)).toEqual([-22, -12, 25])
  })

  it('b=1 quaternion rotates 180 degrees about the first axis', () => {
    const input = base()
    input.qformCode = 1
    input.quatern = [1, 0, 0]
    const { m } = buildAffine(input)
    const [x, y, z] = applyAffine(m, 1, 2, 3)
    expect(x).toBeCloseTo(1)
    expect(y).toBeCloseTo(-2)
    expect(z).toBeCloseTo(-3)
  })

  it('negative qfac flips the third column', () => {
    const input = base()
    input.qformCode = 1
    input.qfacRaw = -1
    const { m } = buildAffine(input)
    expect(applyAffine(m, 0, 0, 5)).toEqual([0, 0, -5])
  })
})
