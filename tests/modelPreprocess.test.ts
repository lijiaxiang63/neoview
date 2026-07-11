import { describe, expect, it } from 'vitest'
import {
  buildModelTransform,
  cropModelInput,
  keepLargestComponents,
  mapModelOutput,
  modelAvailability,
  modelInputNormalization,
  referenceScale,
  sampleModelLinear,
  sampleModelLinearValue
} from '../src/renderer/src/model/preprocess'
import type { Volume } from '../src/renderer/src/volume/types'

const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

function volume(patch: Partial<Volume> = {}): Volume {
  return {
    name: 'v',
    dims: [2, 2, 2],
    frames: 1,
    spacing: [1, 1, 1],
    datatypeCode: 2,
    datatypeName: 'uint8',
    raw: new Uint8Array(8),
    slope: 1,
    inter: 0,
    affine: IDENTITY.slice(),
    transformSource: 'rows',
    suggestedRange: null,
    labels: null,
    stats: { dataMin: 0, dataMax: 1, p2: 0, p98: 1, typeRange: [0, 255] },
    ...patch
  }
}

describe('model preprocessing', () => {
  it('centers the fixed grid on the input world center with the required basis', () => {
    const result = buildModelTransform([256, 256, 256], IDENTITY)
    expect(result).not.toBeNull()
    expect(Array.from(result!.targetAffine)).toEqual([
      -1, 0, 0, 256, 0, 0, 1, 0, 0, -1, 0, 256, 0, 0, 0, 1
    ])
    expect(result!.sourceToTarget[0]).toBe(-1)
    expect(result!.sourceToTarget[7]).toBe(256)
  })

  it('matches the fixed reference Float32 affine arithmetic', () => {
    const affine = IDENTITY.slice()
    affine[3] = 1_000_000_000.25
    affine[7] = -1_000_000_000.5
    const result = buildModelTransform([256, 256, 256], affine)
    expect(result).not.toBeNull()
    expect(result!.targetAffine[3]).toBe(Math.fround(1_000_000_256.25))
    expect(result!.targetAffine[7]).toBe(Math.fround(-1_000_000_000.5))
  })

  it('rejects multi-frame, oversized, and non-invertible inputs', () => {
    expect(modelAvailability(volume()).available).toBe(true)
    expect(modelAvailability(volume({ frames: 2 })).reason).toMatch(/single-frame/)
    expect(
      modelAvailability(volume({ dims: [1024, 1024, 33], raw: new Uint8Array(8) })).reason
    ).toMatch(/too large/)
    expect(modelAvailability(volume({ affine: new Float64Array(16) })).reason).toMatch(
      /non-invertible/
    )
  })

  it('applies scaled trilinear interpolation and treats non-finite samples as zero', () => {
    const raw = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7])
    expect(sampleModelLinear(raw, [2, 2, 2], 0.5, 0.5, 0.5, 2, 1)).toBe(8)
    raw[7] = Number.NaN
    expect(sampleModelLinear(raw, [2, 2, 2], 1, 1, 1, 1, 0)).toBe(0)
    expect(sampleModelLinear(raw, [2, 2, 2], -0.1, 0, 0, 1, 0)).toBe(0)
    expect(sampleModelLinearValue(raw, [2, 2, 2], -0.1, 0, 0, 1, 0)).toBeNull()
    expect(sampleModelLinearValue(raw, [2, 2, 2], 1, 1, 1, 1, -20)).toBeNull()
  })

  it('preserves scaled 8-bit intensities like the fixed reference path', () => {
    const raw = new Uint8Array([0, 10, 20, 30, 40, 250])
    expect(referenceScale(raw, 2, 1, -5)).toEqual({ min: -5, scale: 1 })
  })

  it('preserves the fixed reference shortcut for stored 8-bit input', () => {
    const raw = new Uint8Array([0, 64, 128, 255])
    const result = referenceScale(raw, 2, 2, 0)
    const mapped = Array.from(raw, (value) =>
      Math.trunc(Math.max(0, Math.min(255, result.scale * (value * 2 - result.min))))
    )
    expect(result).toEqual({ min: 0, scale: 1 })
    expect(mapped).toEqual([0, 128, 255, 255])
  })

  it('uses the central half-volume range before the fixed histogram', () => {
    const raw = new Int16Array(4 * 4 * 4)
    raw.fill(100)
    for (let z = 1; z < 3; z++) {
      for (let y = 1; y < 3; y++) {
        for (let x = 1; x < 3; x++) raw[x + y * 4 + z * 16] = 10 + x + y + z
      }
    }
    raw[0] = -1000
    const result = referenceScale(raw, 4, 1, 0, [4, 4, 4])
    expect(result.min).toBe(13)
    expect(result.scale).toBeGreaterThan(1)
  })

  it('matches the fixed reference histogram upper-bin rule', () => {
    const raw = new Int16Array(1000)
    for (let index = 0; index < raw.length; index++) raw[index] = index
    const result = referenceScale(raw, 4, 1, 0)
    expect(result.min).toBe(0)
    expect(result.scale).toBeCloseTo(255 / 997.002, 12)
  })

  it('uses exact five and ninety-five percent ranks for quantile normalization', () => {
    const grid = new Uint8Array(100)
    for (let index = 0; index < grid.length; index++) grid[index] = index
    expect(modelInputNormalization(grid, 'quantile')).toEqual({
      min: 5,
      max: 94,
      dataMax: 99,
      scale: 1 / 89
    })
  })

  it('applies a fraction of the normalized maximum and padding to crop bounds', () => {
    const grid = new Uint8Array(256 ** 3)
    const index = (x: number, y: number, z: number): number => x + y * 256 + z * 256 ** 2
    grid[index(10, 20, 30)] = 100
    grid[index(11, 21, 31)] = 101
    grid[index(200, 200, 200)] = 200
    const prepared = cropModelInput(
      { data: grid, sourceToTarget: IDENTITY },
      { min: 0, max: 100, dataMax: 200, scale: 0.01 },
      0.5,
      2
    )
    expect(prepared?.corner).toEqual([9, 19, 29])
    expect(prepared?.dims).toEqual([194, 184, 174])
  })

  it('uses an external prerequisite mask and clips padding at the fixed-grid edge', () => {
    const grid = new Uint8Array(256 ** 3)
    const mask = new Uint8Array(grid.length)
    mask[250] = 1
    const prepared = cropModelInput(
      { data: grid, sourceToTarget: IDENTITY },
      { min: 0, max: 1, dataMax: 1, scale: 1 },
      0,
      10,
      mask
    )
    expect(prepared?.corner).toEqual([240, 0, 0])
    expect(prepared?.dims).toEqual([16, 11, 11])
  })

  it('keeps only the largest 26-neighbor component of each nonzero class', () => {
    const labels = new Uint8Array(27)
    labels[0] = 1
    labels[1] = 1
    labels[26] = 1
    labels[3] = 2
    labels[4] = 2
    labels[5] = 2
    labels[20] = 2
    const result = keepLargestComponents(labels, [3, 3, 3])
    expect(Array.from(result).filter((value) => value === 1)).toHaveLength(2)
    expect(Array.from(result).filter((value) => value === 2)).toHaveLength(3)
    expect(result[26]).toBe(0)
    expect(result[20]).toBe(0)
  })

  it('merges nonzero classes before retaining the largest binary component', () => {
    const labels = new Uint8Array(27)
    labels[0] = 1
    labels[1] = 2
    labels[26] = 3
    const result = keepLargestComponents(labels, [3, 3, 3], 4, true)
    expect(Array.from(result).filter((value) => value === 1)).toHaveLength(2)
    expect(result[26]).toBe(0)
  })

  it('pastes tensor-order output and maps it back with nearest-neighbor sampling', () => {
    const labels = new Uint8Array([1, 0, 0, 2, 0, 0, 0, 0])
    const result = mapModelOutput(
      labels,
      { dims: [2, 2, 2], corner: [0, 0, 0], sourceToTarget: IDENTITY },
      [2, 2, 2]
    )
    expect(result.counts).toEqual(new Uint32Array([6, 1, 1]))
    expect(result.labels[0]).toBe(1)
    expect(result.labels[3]).toBe(0)
    expect(result.labels[6]).toBe(2)
  })

  it('preserves tensor order for unequal crop dimensions and a nonzero corner', () => {
    const labels = new Uint8Array(2 * 3 * 4)
    labels[14] = 1
    labels[9] = 2
    const sourceToTarget = IDENTITY.slice()
    sourceToTarget[3] = 5
    sourceToTarget[7] = 7
    sourceToTarget[11] = 9
    const result = mapModelOutput(
      labels,
      { dims: [2, 3, 4], corner: [5, 7, 9], sourceToTarget },
      [2, 3, 4]
    )
    expect(result.counts).toEqual(new Uint32Array([22, 1, 1]))
    expect(result.labels[13]).toBe(1)
    expect(result.labels[10]).toBe(2)
  })
})
