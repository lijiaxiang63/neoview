// Layer-facing correction types: the small, session-local config the user edits
// and the resolved result the display gate reads. The heavy compute lives in the
// correction domain; only these light structures ride on the overlay layer.

import type { StatisticInfo } from '../volume/types'
import type { ClusterMembership, ClusterReport } from './clusterReport'
import type { Connectivity } from './connectedComponents'
import type { CorrectionMethod } from './correction'
import { tailForStatistic, type StatisticKind, type Tail } from './pValues'
import type { Smoothness } from './smoothness'

export interface CorrectionStatistic {
  kind: StatisticKind
  /** Degrees of freedom (t / F numerator); 0 when not applicable or unknown. */
  dof1: number
  /** F denominator degrees of freedom; 0 otherwise. */
  dof2: number
}

export interface CorrectionConfig {
  method: CorrectionMethod
  /** Voxel/FWE/FDR level, or cluster-level alpha for cluster-GRF. */
  alpha: number
  /** Cluster-forming voxel p (cluster-GRF only). */
  clusterFormingP: number
  tail: Tail
  connectivity: Connectivity
  statistic: CorrectionStatistic
  /** Restrict the correction (test count, FDR denominator, cluster search volume,
   * and display) to the non-zero voxels of this overlay layer; null = whole map. */
  maskLayerId: number | null
  /** Bumped on every edit; the correction domain's cache key. */
  rev: number
}

export interface SignificanceResult {
  /** Stat-magnitude cutoff; +∞ when nothing survives. */
  statThreshold: number
  /** Minimum surviving cluster size (cluster-GRF), else null. */
  minClusterSize: number | null
  /** Survival mask over the overlay grid for `frame`; null when statThreshold
   * alone gates the display (voxel-level methods). */
  mask: Uint8Array | null
  /** Statistic kind + sidedness the gate needs to interpret `statThreshold`. */
  kind: StatisticKind
  tail: Tail
  survivingVoxels: number
  smoothness: Smoothness | null
  report: ClusterReport | null
  /** Per-record cluster voxels retained so an atlas change can re-annotate the
   * report without re-running correction; null when there is no report. */
  membership: ClusterMembership | null
  /** Which config revision and frame produced this. */
  configRev: number
  frame: number
  /** True between an edit and its recompute completing (keeps the old gate up). */
  stale: boolean
}

export const CORRECTION_DEFAULTS = {
  alpha: 0.05,
  clusterFormingP: 0.001,
  connectivity: 26 as Connectivity,
  tail: 'two' as Tail
}

/** A fresh correction config for a stat-map layer, seeded from the header
 * statistic when present (falling back to a z-map, which needs no dof). */
export function defaultCorrectionConfig(statistic: StatisticInfo | null): CorrectionConfig {
  return {
    method: 'uncorrected',
    alpha: CORRECTION_DEFAULTS.alpha,
    clusterFormingP: CORRECTION_DEFAULTS.clusterFormingP,
    tail: tailForStatistic(statistic?.kind ?? 'z', CORRECTION_DEFAULTS.tail),
    connectivity: CORRECTION_DEFAULTS.connectivity,
    statistic: {
      kind: statistic?.kind ?? 'z',
      dof1: statistic?.dof1 ?? 0,
      dof2: statistic?.dof2 ?? 0
    },
    maskLayerId: null,
    rev: 0
  }
}
