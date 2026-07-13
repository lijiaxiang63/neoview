// Gaussian-random-field cluster-extent threshold (Friston et al. 1994) for a
// D=3 field. Given the search-volume voxel count, the resolution-element density
// dLh, and a cluster-forming voxel p, it derives the cluster-forming z threshold
// and the minimum surviving cluster size via the expected Euler characteristic.
// Pure; depends only on distributions.ts.

import { GAMMA_2_5, normalInv, normalSf } from './distributions'

import type { Tail } from './pValues'

export interface GrfInput {
  /** In-mask voxel count (the search volume). */
  n: number
  /** Resolution-element density from the smoothness estimate. */
  dLh: number
  /** Cluster-forming voxel p-threshold. */
  voxelP: number
  /** Cluster-level significance. */
  clusterP: number
  tail: Tail
}

const D = 3
const TWO_PI_FACTOR = (2 * Math.PI) ** (-(D + 1) / 2) // (2π)^(-2) for D=3

/**
 * Minimum surviving cluster size K such that P(cluster ≥ K) < the cluster-level
 * threshold, from the expected number of clusters Em and expected suprathreshold
 * voxels EN.
 */
function clusterSizeThreshold(n: number, dLh: number, zThr: number, clusterP: number): number {
  if (clusterP <= 0) return n + 1
  const z2 = zThr * zThr
  const Em = n * TWO_PI_FACTOR * dLh * (z2 - 1) ** ((D - 1) / 2) * Math.exp(-z2 / 2)
  const EN = n * normalSf(zThr)
  // A non-finite dLh (e.g. from a degenerate smoothness estimate) must not
  // silently collapse the size threshold to 1: `NaN <= 0` is false.
  if (!Number.isFinite(Em) || !Number.isFinite(EN) || Em <= 0 || EN <= 0) return 1

  const beta = ((GAMMA_2_5 * Em) / EN) ** (2 / D)
  if (!Number.isFinite(beta)) return 1
  let size = 0
  let p = 1
  while (p >= clusterP && size < n) {
    size += 1
    p = 1 - Math.exp(-Em * Math.exp(-beta * size ** (2 / D)))
  }
  return Math.max(size, 1)
}

/**
 * Cluster-forming z threshold and minimum cluster size. Two-tailed inference
 * forms clusters at voxel-p/2 and corrects each tail at cluster-p/2 so the
 * combined false-positive rate equals clusterP.
 */
export function clusterExtentThreshold(input: GrfInput): {
  zThreshold: number
  minClusterSize: number
} {
  const { n, dLh, voxelP, clusterP, tail } = input
  const zThreshold = tail === 'two' ? normalInv(1 - voxelP / 2) : normalInv(1 - voxelP)
  const effectiveClusterP = tail === 'two' ? clusterP / 2 : clusterP
  const minClusterSize = clusterSizeThreshold(n, dLh, zThreshold, effectiveClusterP)
  return { zThreshold, minClusterSize }
}
