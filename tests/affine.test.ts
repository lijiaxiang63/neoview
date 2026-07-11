import { describe, expect, it } from 'vitest'
import {
  applyAffine,
  buildAffine,
  composeVoxelMap,
  invertAffine,
  multiplyAffine,
  voxelDirectionFromWorld,
  worldAxesForVoxelAxes,
  type AffineInput
} from '../src/renderer/src/volume/affine'

const base = (): AffineInput => ({
  rowTransformAvailable: false,
  rotationTransformAvailable: false,
  rows: [new Float64Array(4), new Float64Array(4), new Float64Array(4)],
  rotation: [0, 0, 0],
  translation: [0, 0, 0],
  thirdAxisSign: 1,
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
    input.rowTransformAvailable = true
    input.rotationTransformAvailable = true
    input.rows[0].set([1, 0, 0, 10])
    input.rows[1].set([0, 1, 0, 20])
    input.rows[2].set([0, 0, 1, 30])
    input.rotation = [1, 0, 0] // would be a 180-degree rotation if used
    const { m, source } = buildAffine(input)
    expect(source).toBe('rows')
    expect(applyAffine(m, 5, 6, 7)).toEqual([15, 26, 37])
  })

  it('identity quaternion equals spacing diagonal plus offset', () => {
    const input = base()
    input.rotationTransformAvailable = true
    input.spacing = [1, 1, 2.5]
    input.translation = [-32, -32, -50]
    const { m, source } = buildAffine(input)
    expect(source).toBe('quaternion')
    expect(applyAffine(m, 10, 20, 30)).toEqual([-22, -12, 25])
  })

  it('b=1 quaternion rotates 180 degrees about the first axis', () => {
    const input = base()
    input.rotationTransformAvailable = true
    input.rotation = [1, 0, 0]
    const { m } = buildAffine(input)
    const [x, y, z] = applyAffine(m, 1, 2, 3)
    expect(x).toBeCloseTo(1)
    expect(y).toBeCloseTo(-2)
    expect(z).toBeCloseTo(-3)
  })

  it('negative thirdAxisSign flips the third column', () => {
    const input = base()
    input.rotationTransformAvailable = true
    input.thirdAxisSign = -1
    const { m } = buildAffine(input)
    expect(applyAffine(m, 0, 0, 5)).toEqual([0, 0, -5])
  })
})

const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

function expectClose(a: Float64Array, b: ArrayLike<number>, digits = 9): void {
  for (let i = 0; i < 16; i++) expect(a[i]).toBeCloseTo(b[i], digits)
}

describe('invertAffine', () => {
  it('inverts the identity to itself', () => {
    const inv = invertAffine(IDENTITY)
    expect(inv).not.toBeNull()
    expectClose(inv!, IDENTITY)
  })

  it('round-trips a scaled and translated matrix', () => {
    const input = base()
    input.rowTransformAvailable = true
    input.rows[0].set([2, 0, 0, 10])
    input.rows[1].set([0, 3, 0, -20])
    input.rows[2].set([0, 0, 0.5, 7])
    const { m } = buildAffine(input)
    const inv = invertAffine(m)!
    expectClose(multiplyAffine(inv, m), IDENTITY)
    const [x, y, z] = applyAffine(m, 3, 4, 5)
    const [i, j, k] = applyAffine(inv, x, y, z)
    expect(i).toBeCloseTo(3, 9)
    expect(j).toBeCloseTo(4, 9)
    expect(k).toBeCloseTo(5, 9)
  })

  it('round-trips a quaternion-built affine', () => {
    const input = base()
    input.rotationTransformAvailable = true
    input.rotation = [0.3, 0.2, 0.1]
    input.translation = [-12, 5, 33]
    input.spacing = [1, 1.5, 2.5]
    const { m } = buildAffine(input)
    const inv = invertAffine(m)!
    expectClose(multiplyAffine(m, inv), IDENTITY)
    const [x, y, z] = applyAffine(m, 6, 7, 8)
    const [i, j, k] = applyAffine(inv, x, y, z)
    expect(i).toBeCloseTo(6, 9)
    expect(j).toBeCloseTo(7, 9)
    expect(k).toBeCloseTo(8, 9)
  })

  it('returns null for a singular matrix', () => {
    const m = new Float64Array(IDENTITY)
    m[10] = 0 // zero third axis column
    expect(invertAffine(m)).toBeNull()
  })
})

describe('composeVoxelMap', () => {
  it('is identity when both grids share an affine', () => {
    const input = base()
    input.rotationTransformAvailable = true
    input.rotation = [0.2, 0.1, 0.05]
    input.translation = [4, -9, 2]
    input.spacing = [0.7, 1.1, 3]
    const { m } = buildAffine(input)
    expectClose(composeVoxelMap(m, m)!, IDENTITY)
  })

  it('maps through a translation offset', () => {
    const overlay = new Float64Array(IDENTITY)
    overlay[3] = 10 // overlay origin shifted +10 along world axis 0
    const m = composeVoxelMap(IDENTITY, overlay)!
    expect(applyAffine(m, 12, 3, 4)).toEqual([2, 3, 4])
  })

  it('maps a fine base grid into a coarse overlay grid', () => {
    const overlay = new Float64Array(IDENTITY)
    overlay[0] = 2
    overlay[5] = 2
    overlay[10] = 2
    const m = composeVoxelMap(IDENTITY, overlay)!
    expect(applyAffine(m, 6, 4, 2)).toEqual([3, 2, 1])
  })

  it('is null when the overlay affine is singular', () => {
    const overlay = new Float64Array(IDENTITY)
    overlay[5] = 0
    expect(composeVoxelMap(IDENTITY, overlay)).toBeNull()
  })
})

describe('world and voxel axis mapping', () => {
  it('maps directions through a signed axis permutation', () => {
    const affine = new Float64Array([-1, 0, 0, 0, 0, 0, 1, -293, 0, -1, 0, 0, 0, 0, 0, 1])
    expect(worldAxesForVoxelAxes(affine)).toEqual([0, 2, 1])
    expect(voxelDirectionFromWorld(affine, [1, 2, 3])).toEqual([-1, -3, 2])
  })

  it('preserves directions for aligned positive axes', () => {
    expect(worldAxesForVoxelAxes(IDENTITY)).toEqual([0, 1, 2])
    expect(voxelDirectionFromWorld(IDENTITY, [1, 2, 3])).toEqual([1, 2, 3])
  })
})
