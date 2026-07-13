import { describe, expect, it } from 'vitest'
import { clusterExtentThreshold } from '../src/renderer/src/stats/grf'

describe('clusterExtentThreshold', () => {
  it('reproduces the reference cluster-forming z thresholds', () => {
    expect(
      clusterExtentThreshold({ n: 100000, dLh: 0.5, voxelP: 0.001, clusterP: 0.05, tail: 'two' })
        .zThreshold
    ).toBeCloseTo(3.2905267314919247, 6)
    expect(
      clusterExtentThreshold({ n: 100000, dLh: 0.5, voxelP: 0.001, clusterP: 0.05, tail: 'one' })
        .zThreshold
    ).toBeCloseTo(3.090232306167813, 6)
  })

  it('reproduces reference minimum cluster sizes (Python port)', () => {
    const two = { voxelP: 0.001, clusterP: 0.05, tail: 'two' as const }
    expect(clusterExtentThreshold({ n: 100000, dLh: 0.5, ...two }).minClusterSize).toBe(15)
    expect(clusterExtentThreshold({ n: 100000, dLh: 0.2, ...two }).minClusterSize).toBe(30)
    expect(clusterExtentThreshold({ n: 200000, dLh: 0.5, ...two }).minClusterSize).toBe(17)
    expect(
      clusterExtentThreshold({ n: 100000, dLh: 0.5, voxelP: 0.001, clusterP: 0.05, tail: 'one' })
        .minClusterSize
    ).toBe(17)
  })

  it('minimum cluster size decreases as the cluster-level threshold relaxes', () => {
    const base = { n: 100000, dLh: 0.5, voxelP: 0.001, tail: 'two' as const }
    const lenient = clusterExtentThreshold({ ...base, clusterP: 0.1 }).minClusterSize
    const strict = clusterExtentThreshold({ ...base, clusterP: 0.01 }).minClusterSize
    expect(lenient).toBe(13)
    expect(strict).toBe(20)
    expect(lenient).toBeLessThan(strict)
  })
})
