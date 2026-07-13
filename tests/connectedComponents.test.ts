import { describe, expect, it } from 'vitest'
import { labelClusters } from '../src/renderer/src/stats/connectedComponents'

const dims: [number, number, number] = [4, 4, 4]
const idx = (i: number, j: number, k: number): number => i + j * 4 + k * 16

describe('labelClusters', () => {
  it('separates diagonally-touching voxels under 6-connectivity, merges them under 26', () => {
    const mask = new Uint8Array(64)
    mask[idx(0, 0, 0)] = 1
    mask[idx(1, 1, 0)] = 1 // only face-diagonal contact

    const six = labelClusters(mask, dims, 6)
    expect(six.count).toBe(2)
    expect([...six.sizes]).toEqual([1, 1])

    const twentySix = labelClusters(mask, dims, 26)
    expect(twentySix.count).toBe(1)
    expect([...twentySix.sizes]).toEqual([2])
  })

  it('labels two separate solid blocks and accounts for all voxels', () => {
    const mask = new Uint8Array(64)
    let total = 0
    // block A: 2x2x1 at origin
    for (let j = 0; j < 2; j++)
      for (let i = 0; i < 2; i++) {
        mask[idx(i, j, 0)] = 1
        total++
      }
    // block B: single voxel far away
    mask[idx(3, 3, 3)] = 1
    total++

    const cc = labelClusters(mask, dims, 26)
    expect(cc.count).toBe(2)
    expect([...cc.sizes].reduce((a, b) => a + b, 0)).toBe(total)
    expect([...cc.sizes].sort((a, b) => b - a)).toEqual([4, 1])
  })

  it('handles an empty mask', () => {
    const cc = labelClusters(new Uint8Array(64), dims, 26)
    expect(cc.count).toBe(0)
    expect(cc.sizes.length).toBe(0)
  })

  it('labels a fully-filled volume as one component', () => {
    const cc = labelClusters(new Uint8Array(64).fill(1), dims, 6)
    expect(cc.count).toBe(1)
    expect(cc.sizes[0]).toBe(64)
  })
})
