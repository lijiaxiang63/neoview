import { describe, expect, it } from 'vitest'
import { labelClusters } from '../src/renderer/src/stats/connectedComponents'
import { buildClusterReport, clusterReportToCsv } from '../src/renderer/src/stats/clusterReport'

const dims: [number, number, number] = [4, 4, 4]
const idx = (i: number, j: number, k: number): number => i + j * 4 + k * 16
const AFFINE = new Float64Array([2, 0, 0, -10, 0, 2, 0, -20, 0, 0, 3, 5, 0, 0, 0, 1])

describe('buildClusterReport', () => {
  it('reports peak, voxel volume, and world coordinate', () => {
    const mask = new Uint8Array(64)
    const values = new Float64Array(64)
    // 2×2×1 block; the signed peak (max |value|) sits at (1,1,0).
    for (let j = 0; j < 2; j++)
      for (let i = 0; i < 2; i++) {
        mask[idx(i, j, 0)] = 1
        values[idx(i, j, 0)] = 1
      }
    values[idx(1, 1, 0)] = -9

    const cc = labelClusters(mask, dims, 26)
    const report = buildClusterReport(values, dims, AFFINE, cc, 1)
    expect(report.records).toHaveLength(1)
    const r = report.records[0]
    expect(r.id).toBe(1)
    expect(r.voxelCount).toBe(4)
    expect(r.volumeWorld).toBeCloseTo(4 * 2 * 2 * 3, 9) // 4 voxels × |det(diag(2,2,3))|
    expect(r.peakStat).toBe(-9)
    expect(r.peakVoxel).toEqual([1, 1, 0])
    expect(r.peakWorld).toEqual([2 * 1 - 10, 2 * 1 - 20, 3 * 0 + 5])
    expect(report.keptVoxels).toBe(4)
  })

  it('orders clusters largest first and drops sub-threshold clusters', () => {
    const mask = new Uint8Array(64)
    const values = new Float64Array(64)
    // big block (4 voxels) and a lone voxel
    for (let i = 0; i < 4; i++) {
      mask[idx(i, 0, 0)] = 1
      values[idx(i, 0, 0)] = 2
    }
    mask[idx(3, 3, 3)] = 1
    values[idx(3, 3, 3)] = 5

    const cc = labelClusters(mask, dims, 6)
    const all = buildClusterReport(values, dims, AFFINE, cc, 1)
    expect(all.records.map((r) => r.voxelCount)).toEqual([4, 1])
    expect(all.records[0].id).toBe(1)

    const filtered = buildClusterReport(values, dims, AFFINE, cc, 2)
    expect(filtered.records).toHaveLength(1)
    expect(filtered.records[0].voxelCount).toBe(4)
  })

  it('uses the smallest value as the peak for a p-value map', () => {
    const mask = new Uint8Array(64)
    const values = new Float64Array(64)
    mask[idx(0, 0, 0)] = 1
    mask[idx(1, 0, 0)] = 1
    values[idx(0, 0, 0)] = 0.04
    values[idx(1, 0, 0)] = 0.001

    const cc = labelClusters(mask, dims, 6)
    const report = buildClusterReport(values, dims, AFFINE, cc, 1, 'minimum')
    expect(report.records[0].peakStat).toBe(0.001)
    expect(report.records[0].peakVoxel).toEqual([1, 0, 0])
  })

  it('uses |det| for volume with a rotated (oblique) affine', () => {
    // 90° rotation in-plane with scales 2,2,3 → |det| still 12.
    const rotated = new Float64Array([0, -2, 0, 1, 2, 0, 0, 2, 0, 0, 3, 3, 0, 0, 0, 1])
    const mask = new Uint8Array(64)
    const values = new Float64Array(64)
    mask[idx(0, 0, 0)] = 1
    values[idx(0, 0, 0)] = 1
    const cc = labelClusters(mask, dims, 26)
    const report = buildClusterReport(values, dims, rotated, cc, 1)
    expect(report.records[0].volumeWorld).toBeCloseTo(12, 9)
  })

  it('serializes to neutral CSV columns', () => {
    const mask = new Uint8Array(64)
    const values = new Float64Array(64)
    mask[idx(0, 0, 0)] = 1
    values[idx(0, 0, 0)] = 3.5
    const cc = labelClusters(mask, dims, 26)
    const csv = clusterReportToCsv(buildClusterReport(values, dims, AFFINE, cc, 1))
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('cluster,voxels,volume,peak,i,j,k,x,y,z')
    expect(lines[1]).toBe('1,1,12.00,3.5000,0,0,0,-10.00,-20.00,5.00')
  })
})
