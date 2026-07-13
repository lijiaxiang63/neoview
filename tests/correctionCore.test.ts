import { describe, expect, it } from 'vitest'
import {
  computeCorrection,
  countInMask,
  isInMask,
  type CorrectionRequest
} from '../src/renderer/src/stats/correctionCore'
import { annotateReport } from '../src/renderer/src/stats/atlasAnnotation'
import type { Volume } from '../src/renderer/src/volume/types'

const N = 16
const DIMS: [number, number, number] = [N, N, N]
const idx = (i: number, j: number, k: number): number => i + j * N + k * N * N

function identity(): Float64Array {
  const m = new Float64Array(16)
  m[0] = m[5] = m[10] = m[15] = 1
  return m
}

/** A z-map: background 0.3, a solid 6³ blob of z=6 at the centre, plus one NaN
 * and one 0 voxel that the implicit mask must exclude. */
function plantedMap(): Float64Array {
  const values = new Float64Array(N * N * N).fill(0.3)
  for (let k = 5; k < 11; k++)
    for (let j = 5; j < 11; j++) for (let i = 5; i < 11; i++) values[idx(i, j, k)] = 6
  values[idx(0, 0, 0)] = NaN
  values[idx(1, 0, 0)] = 0
  return values
}

const BLOB = 6 * 6 * 6

/** An atlas label volume on the stat grid from a raw label array. */
function mkAtlasVolume(raw: Uint8Array): Volume {
  return {
    name: 'atlas',
    dims: DIMS,
    frames: 1,
    spacing: [1, 1, 1],
    datatypeCode: 2,
    datatypeName: 'uint8',
    raw,
    slope: 1,
    inter: 0,
    affine: identity(),
    transformSource: 'spacing-fallback',
    suggestedRange: null,
    labels: null,
    statistic: null,
    smoothness: null,
    stats: { dataMin: 0, dataMax: 2, p2: 0, p98: 2, typeRange: [0, 255] }
  }
}

/** Atlas split at i=8: region 1 for i<8, region 2 for i>=8. */
function splitAtlas(): { volume: Volume; names: Map<number, string> } {
  const raw = new Uint8Array(N * N * N)
  for (let k = 0; k < N; k++)
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) raw[idx(i, j, k)] = i < 8 ? 1 : 2
  return {
    volume: mkAtlasVolume(raw),
    names: new Map([
      [1, 'Left'],
      [2, 'Right']
    ])
  }
}

function baseRequest(method: CorrectionRequest['method']): CorrectionRequest {
  return {
    values: plantedMap(),
    dims: DIMS,
    affine: identity(),
    spacing: [1, 1, 1],
    statistic: { kind: 'z', dof1: 0, dof2: 0 },
    method,
    alpha: 0.05,
    clusterFormingP: 0.001,
    tail: 'two',
    connectivity: 26,
    includeReport: true
  }
}

describe('isInMask / countInMask', () => {
  it('excludes zero and non-finite voxels', () => {
    expect(isInMask(0)).toBe(false)
    expect(isInMask(NaN)).toBe(false)
    expect(isInMask(Infinity)).toBe(false)
    expect(isInMask(0.3)).toBe(true)
    expect(countInMask(plantedMap())).toBe(N * N * N - 2)
  })
})

describe('computeCorrection — voxel-level methods', () => {
  it('uncorrected keeps only the supra-threshold blob', () => {
    const r = computeCorrection(baseRequest('uncorrected'))
    expect(r.statThreshold).toBeCloseTo(1.959963984540054, 6)
    expect(r.survivingVoxels).toBe(BLOB)
    expect(r.mask).toBeNull()
    expect(r.report?.records).toHaveLength(1)
    expect(r.report?.records[0].peakStat).toBe(6)
    expect(r.report?.records[0].voxelCount).toBe(BLOB)
  })

  it('Bonferroni uses alpha/m and still keeps the strong blob', () => {
    const r = computeCorrection(baseRequest('bonferroni'))
    // threshold = Φ⁻¹(1 − (0.05/m)/2), m = 4094
    expect(r.statThreshold).toBeGreaterThan(4)
    expect(r.statThreshold).toBeLessThan(5)
    expect(r.survivingVoxels).toBe(BLOB)
  })

  it('FDR keeps the blob and reports it as one cluster', () => {
    const r = computeCorrection(baseRequest('fdr'))
    expect(r.survivingVoxels).toBe(BLOB)
    expect(r.report?.records).toHaveLength(1)
  })

  it('does not scan clusters when includeReport is false', () => {
    const r = computeCorrection({ ...baseRequest('uncorrected'), includeReport: false })
    expect(r.report).toBeNull()
    expect(r.survivingVoxels).toBe(BLOB)
  })
})

describe('computeCorrection — cluster-GRF', () => {
  it('produces a survival mask and keeps the blob cluster', () => {
    const r = computeCorrection(baseRequest('cluster-grf'))
    expect(r.mask).not.toBeNull()
    expect(r.smoothness).not.toBeNull()
    expect(r.minClusterSize).toBeGreaterThan(0)
    expect(r.minClusterSize).toBeLessThan(BLOB)
    expect(r.survivingVoxels).toBe(BLOB)
    expect(r.mask?.[idx(7, 7, 7)]).toBe(1)
    expect(r.mask?.[idx(0, 5, 5)]).toBe(0)
    expect(r.report?.records[0].peakStat).toBe(6)
    expect(r.report?.records[0].voxelCount).toBe(BLOB)
  })

  it('drops the cluster when it is below the minimum size', () => {
    // A single supra-threshold voxel can never exceed the GRF cluster-size floor.
    const values = new Float64Array(N * N * N).fill(0.3)
    values[idx(8, 8, 8)] = 6
    const r = computeCorrection({ ...baseRequest('cluster-grf'), values })
    expect(r.survivingVoxels).toBe(0)
    expect(r.report?.records).toHaveLength(0)
  })

  it('is not defeated by a single extreme voxel (finite smoothness)', () => {
    // z→∞ underflow used to poison smoothness → dLh NaN → minClusterSize 1.
    const values = plantedMap()
    values[idx(3, 3, 3)] = 45 // extreme spike inside the blob (t-equivalent huge)
    const r = computeCorrection({
      ...baseRequest('cluster-grf'),
      values,
      statistic: { kind: 't', dof1: 30, dof2: 0 }
    })
    expect(r.smoothness && Number.isFinite(r.smoothness.dLh)).toBe(true)
    expect(r.minClusterSize).toBeGreaterThan(1)
  })
})

describe('computeCorrection — degenerate inputs', () => {
  it('a t-map with no degrees of freedom hides everything (no garbage)', () => {
    const r = computeCorrection({
      ...baseRequest('uncorrected'),
      statistic: { kind: 't', dof1: 0, dof2: 0 }
    })
    expect(r.statThreshold).toBe(Infinity)
    expect(r.survivingVoxels).toBe(0)
  })

  it('FDR that rejects nothing hides everything on a z-map', () => {
    const values = new Float64Array(N * N * N).fill(0.3) // no supra-threshold voxels
    const r = computeCorrection({ ...baseRequest('fdr'), values })
    expect(r.statThreshold).toBe(Infinity)
    expect(r.survivingVoxels).toBe(0)
  })

  it('FDR that rejects nothing on a p-map hides everything (not everything shown)', () => {
    // The C1 inversion: a p-map + FDR with nothing significant must show 0, not all.
    const values = new Float64Array(N * N * N).fill(0.5)
    const r = computeCorrection({
      ...baseRequest('fdr'),
      values,
      statistic: { kind: 'p', dof1: 0, dof2: 0 }
    })
    expect(r.survivingVoxels).toBe(0)
  })

  it('FDR keeps voxels whose p underflows to exactly 0', () => {
    const values = new Float64Array(N * N * N).fill(0.0001)
    for (let k = 5; k < 8; k++)
      for (let j = 5; j < 8; j++) for (let i = 5; i < 8; i++) values[idx(i, j, k)] = 50
    const r = computeCorrection({ ...baseRequest('fdr'), values })
    expect(r.survivingVoxels).toBe(27) // the z=50 block, not hidden by a +∞ threshold
  })
})

describe('computeCorrection — cluster membership', () => {
  it('returns per-record membership that re-annotates the report against an atlas', () => {
    // computeCorrection itself does NOT annotate — it returns geometry + membership.
    const r = computeCorrection(baseRequest('uncorrected'))
    expect(r.report!.records[0].peakRegion).toBeUndefined()
    expect(r.membership).not.toBeNull()
    expect(r.membership!.offsets[r.membership!.offsets.length - 1]).toBe(BLOB)

    // Annotation is a separate main-thread step over (report, membership, atlas).
    // The planted 6³ blob sits at i=5..10, straddling the i=8 atlas boundary.
    annotateReport(r.report!, r.membership, identity(), splitAtlas())
    const record = r.report!.records[0]
    expect(record.peakRegion === 'Left' || record.peakRegion === 'Right').toBe(true)
    expect(record.regions).toMatch(/Left\(\d+%\)/)
    expect(record.regions).toMatch(/Right\(\d+%\)/)
  })

  it('builds membership for a two-tailed GRF report that annotates each sign tail', () => {
    // A positive blob wholly in region 1 (i<8) and a negative blob wholly in
    // region 2 (i>=8): the GRF path renumbers pos-then-neg (label != size rank),
    // so this exercises buildMembership's peak-voxel matching on combinedLabels.
    const values = new Float64Array(N * N * N).fill(0.3)
    for (let k = 5; k < 11; k++)
      for (let j = 5; j < 11; j++) for (let i = 1; i < 7; i++) values[idx(i, j, k)] = 6
    for (let k = 5; k < 11; k++)
      for (let j = 5; j < 11; j++) for (let i = 9; i < 15; i++) values[idx(i, j, k)] = -6
    const r = computeCorrection({ ...baseRequest('cluster-grf'), values, tail: 'two' })
    expect(r.report!.records).toHaveLength(2)

    annotateReport(r.report!, r.membership, identity(), splitAtlas())
    const pos = r.report!.records.find((x) => x.peakStat > 0)!
    const neg = r.report!.records.find((x) => x.peakStat < 0)!
    expect(pos.regions).toMatch(/Left\(100%\)/)
    expect(neg.regions).toMatch(/Right\(100%\)/)
  })

  it('omits membership when the report is skipped', () => {
    const r = computeCorrection({ ...baseRequest('uncorrected'), includeReport: false })
    expect(r.membership).toBeNull()
  })
})

describe('computeCorrection — statistic kinds and tails', () => {
  it('a one-tailed t-map keeps only the positive tail', () => {
    const values = new Float64Array(N * N * N).fill(0.1)
    for (let k = 5; k < 11; k++)
      for (let j = 5; j < 11; j++) for (let i = 5; i < 11; i++) values[idx(i, j, k)] = 4
    values[idx(1, 1, 1)] = -4 // a strong negative voxel must NOT survive one-tailed
    const r = computeCorrection({
      ...baseRequest('uncorrected'),
      values,
      statistic: { kind: 't', dof1: 30, dof2: 0 },
      tail: 'one'
    })
    expect(r.survivingVoxels).toBe(BLOB) // the +4 block only; the −4 voxel excluded
  })

  it('an F-map thresholds one-sided', () => {
    const values = new Float64Array(N * N * N).fill(0.5)
    for (let k = 5; k < 11; k++)
      for (let j = 5; j < 11; j++) for (let i = 5; i < 11; i++) values[idx(i, j, k)] = 20
    const r = computeCorrection({
      ...baseRequest('uncorrected'),
      values,
      statistic: { kind: 'f', dof1: 3, dof2: 40 },
      tail: 'two' // ignored for F
    })
    expect(r.survivingVoxels).toBe(BLOB) // F≈20 with (3,40) dof is highly significant
  })
})
