import { describe, expect, it } from 'vitest'
import {
  annotatePeakRegions,
  annotateRegionOverlap,
  annotateReport,
  reannotateReport,
  type Atlas
} from '../src/renderer/src/stats/atlasAnnotation'
import { labelClusters } from '../src/renderer/src/stats/connectedComponents'
import { buildClusterReport, buildMembership } from '../src/renderer/src/stats/clusterReport'
import type { Volume } from '../src/renderer/src/volume/types'

const N = 4
const at = (i: number, j: number, k: number): number => i + j * N + k * N * N

function identity(): Float64Array {
  const m = new Float64Array(16)
  m[0] = m[5] = m[10] = m[15] = 1
  return m
}

/** An atlas on the same grid as the stat map: region 1 fills the x<2 half,
 * region 2 fills x≥2. */
function atlas(): Atlas {
  const raw = new Uint8Array(N * N * N)
  for (let k = 0; k < N; k++)
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) raw[at(i, j, k)] = i < 2 ? 1 : 2
  const volume: Volume = {
    name: 'atlas',
    dims: [N, N, N],
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
  return {
    volume,
    names: new Map([
      [1, 'Left'],
      [2, 'Right']
    ])
  }
}

describe('annotatePeakRegions', () => {
  it('labels the peak voxel with its atlas region', () => {
    const records = [
      {
        id: 1,
        voxelCount: 2,
        volumeWorld: 2,
        peakStat: 5,
        peakVoxel: [0, 0, 0] as [number, number, number],
        peakWorld: [0, 0, 0] as [number, number, number]
      },
      {
        id: 2,
        voxelCount: 2,
        volumeWorld: 2,
        peakStat: 4,
        peakVoxel: [3, 3, 3] as [number, number, number],
        peakWorld: [3, 3, 3] as [number, number, number]
      }
    ]
    annotatePeakRegions(records, identity(), atlas())
    expect(records[0].peakRegion).toBe('Left')
    expect(records[1].peakRegion).toBe('Right')
  })

  it('marks a peak outside the atlas as unlabeled', () => {
    const records = [
      {
        id: 1,
        voxelCount: 1,
        volumeWorld: 1,
        peakStat: 5,
        peakVoxel: [99, 0, 0] as [number, number, number],
        peakWorld: [99, 0, 0] as [number, number, number]
      }
    ]
    annotatePeakRegions(records, identity(), atlas())
    expect(records[0].peakRegion).toBe('—')
  })
})

describe('annotateRegionOverlap', () => {
  it('tallies region percentages for a cluster spanning two regions', () => {
    // A cluster spanning x=1..2 at (j=0,k=0): one voxel in region 1, one in 2.
    const mask = new Uint8Array(N * N * N)
    const values = new Float64Array(N * N * N)
    mask[at(1, 0, 0)] = 1
    mask[at(2, 0, 0)] = 1
    values[at(1, 0, 0)] = 5
    values[at(2, 0, 0)] = 4
    const cc = labelClusters(mask, [N, N, N], 26)
    const report = buildClusterReport(values, [N, N, N], identity(), cc, 1)
    const membership = buildMembership(report, cc, [N, N, N])
    annotateRegionOverlap(report.records, membership, identity(), atlas())
    expect(report.records[0].regions).toMatch(/Left\(50%\)/)
    expect(report.records[0].regions).toMatch(/Right\(50%\)/)
  })

  it('attributes overlap to the right cluster when size order ≠ raster-label order', () => {
    // Small cluster B (region 2, low raster index → label 1); larger cluster A
    // (region 1, higher raster index → label 2). buildClusterReport renumbers by
    // size, so record ids (A=1, B=2) do NOT match the raster labels.
    const mask = new Uint8Array(N * N * N)
    const values = new Float64Array(N * N * N)
    for (const [i, j, k] of [
      [2, 0, 0],
      [3, 0, 0]
    ]) {
      mask[at(i, j, k)] = 1
      values[at(i, j, k)] = 4 // cluster B in region 2
    }
    for (const [i, j, k] of [
      [0, 3, 3],
      [1, 3, 3],
      [0, 2, 3]
    ]) {
      mask[at(i, j, k)] = 1
      values[at(i, j, k)] = 5 // cluster A in region 1
    }
    const cc = labelClusters(mask, [N, N, N], 26)
    const report = buildClusterReport(values, [N, N, N], identity(), cc, 1)
    const membership = buildMembership(report, cc, [N, N, N])
    annotateRegionOverlap(report.records, membership, identity(), atlas())
    expect(report.records[0].voxelCount).toBe(3) // cluster A
    expect(report.records[0].regions).toMatch(/Left\(100%\)/)
    expect(report.records[1].voxelCount).toBe(2) // cluster B
    expect(report.records[1].regions).toMatch(/Right\(100%\)/)
  })
})

describe('reannotateReport', () => {
  it('re-labels an existing report against a new atlas without re-running CC', () => {
    // A cluster spanning both atlas halves.
    const mask = new Uint8Array(N * N * N)
    const values = new Float64Array(N * N * N)
    mask[at(1, 0, 0)] = 1
    mask[at(2, 0, 0)] = 1
    values[at(1, 0, 0)] = 5
    values[at(2, 0, 0)] = 4
    const cc = labelClusters(mask, [N, N, N], 26)
    const report = buildClusterReport(values, [N, N, N], identity(), cc, 1)
    const membership = buildMembership(report, cc, [N, N, N])

    const annotated = reannotateReport(report, membership, identity(), atlas())
    expect(annotated).not.toBe(report) // fresh object identity
    expect(annotated.records[0].peakRegion).toBe('Left')
    expect(annotated.records[0].regions).toMatch(/Left\(50%\)/)
    expect(annotated.records[0].regions).toMatch(/Right\(50%\)/)
    // The source report is untouched.
    expect(report.records[0].peakRegion).toBeUndefined()
  })

  it('strips region names when the atlas is cleared to null', () => {
    const mask = new Uint8Array(N * N * N)
    const values = new Float64Array(N * N * N)
    mask[at(1, 0, 0)] = 1
    values[at(1, 0, 0)] = 5
    const cc = labelClusters(mask, [N, N, N], 26)
    const report = buildClusterReport(values, [N, N, N], identity(), cc, 1)
    const membership = buildMembership(report, cc, [N, N, N])
    annotateRegionOverlap(report.records, membership, identity(), atlas())

    const stripped = reannotateReport(report, membership, identity(), null)
    expect(stripped.records[0].peakRegion).toBeUndefined()
    expect(stripped.records[0].regions).toBeUndefined()
  })
})

describe('annotation edge cases', () => {
  /** A stat affine translating x by +100 so every cluster voxel maps outside the
   * atlas grid. */
  function shifted(): Float64Array {
    const m = identity()
    m[3] = 100
    return m
  }

  it('marks a cluster mapping entirely outside the atlas as unlabeled', () => {
    const mask = new Uint8Array(N * N * N)
    const values = new Float64Array(N * N * N)
    mask[at(1, 0, 0)] = 1
    values[at(1, 0, 0)] = 5
    const cc = labelClusters(mask, [N, N, N], 26)
    const report = buildClusterReport(values, [N, N, N], shifted(), cc, 1)
    const membership = buildMembership(report, cc, [N, N, N])
    annotateReport(report, membership, shifted(), atlas())
    expect(report.records[0].peakRegion).toBe('—')
    expect(report.records[0].regions).toBe('—')
  })

  it('handles an empty report (no clusters) without throwing', () => {
    const mask = new Uint8Array(N * N * N) // nothing set
    const values = new Float64Array(N * N * N)
    const cc = labelClusters(mask, [N, N, N], 26)
    const report = buildClusterReport(values, [N, N, N], identity(), cc, 1)
    const membership = buildMembership(report, cc, [N, N, N])
    expect(report.records).toHaveLength(0)
    expect(Array.from(membership.offsets)).toEqual([0])
    expect(membership.voxels).toHaveLength(0)
    const re = reannotateReport(report, membership, identity(), atlas())
    expect(re.records).toHaveLength(0)
  })
})
