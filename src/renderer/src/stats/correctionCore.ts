// The correction orchestrator: takes the scaled statistic values for one frame
// plus a config, and resolves the stat-space threshold, the survival mask
// (cluster methods), and the cluster report. Pure and fully unit-testable; the
// worker is a thin wrapper that extracts a frame's values and calls this.

import {
  buildClusterReport,
  buildMembership,
  type ClusterMembership,
  type ClusterReport
} from './clusterReport'
import { type Components, type Connectivity, labelClusters } from './connectedComponents'
import { type CorrectionMethod, fdrThreshold } from './correction'
import { clusterExtentThreshold } from './grf'
import {
  statCutoffForP,
  statToP,
  statToZ,
  tailForStatistic,
  type StatisticKind,
  type Tail
} from './pValues'
import { estimateSmoothness, type Smoothness } from './smoothness'

export interface StatisticSpec {
  kind: StatisticKind
  dof1: number
  dof2: number
}

export interface CorrectionRequest {
  /** Scaled statistic values for the active frame, in grid order. */
  values: Float64Array
  dims: [number, number, number]
  affine: Float64Array
  spacing: [number, number, number]
  statistic: StatisticSpec
  method: CorrectionMethod
  /** Voxel/FWE/FDR level, or cluster-level alpha for cluster-GRF. */
  alpha: number
  /** Cluster-forming voxel p (cluster-GRF only). */
  clusterFormingP: number
  tail: Tail
  connectivity: Connectivity
  /** Prefer this smoothness (e.g. from the header) over estimating from the map. */
  smoothnessOverride?: Smoothness | null
  /** Restrict the whole correction to voxels where this mask is non-zero (grid
   * order, same dims as `values`). Excluded voxels are dropped from the test
   * count, the FDR denominator, the cluster search, and the display. */
  restrict?: Uint8Array | null
  /** Build the cluster report (and, for voxel methods, the survival mask). */
  includeReport?: boolean
}

export interface CorrectionResult {
  /** Stat-magnitude cutoff; +∞ when nothing survives. */
  statThreshold: number
  /** Minimum surviving cluster size (cluster-GRF), else null. */
  minClusterSize: number | null
  /** Survival mask over the grid for the active frame; null when the display
   * gate can rely on statThreshold alone (voxel-level methods). */
  mask: Uint8Array | null
  survivingVoxels: number
  smoothness: Smoothness | null
  report: ClusterReport | null
  /** Per-record cluster voxels, retained so an atlas change can re-annotate the
   * report without re-running correction; null when there is no report. */
  membership: ClusterMembership | null
}

type ProgressStage = 'scan' | 'smoothness' | 'clusters' | 'report'

/** A voxel is part of the analysis mask iff it is finite and non-zero. This one
 * predicate drives the test count m, the FDR denominator, the smoothness pairs,
 * and the cluster search volume. */
export function isInMask(v: number, kind?: StatisticKind): boolean {
  if (v === 0 || !Number.isFinite(v)) return false
  if (kind === 'p') return v > 0 && v <= 1
  if (kind === 'f') return v > 0
  return true
}

/** Per-voxel significance test matching the display gate: p-maps keep the
 * smaller values; two-tailed keeps |stat| ≥ cutoff; one-tailed keeps stat ≥ cutoff. */
function survivesPredicate(
  kind: StatisticKind,
  tail: Tail,
  threshold: number
): (v: number) => boolean {
  if (kind === 'p') return (v) => v <= threshold
  if (tail === 'two') return (v) => Math.abs(v) >= threshold
  return (v) => v >= threshold
}

function countInMask(
  values: Float64Array,
  restrict?: Uint8Array | null,
  kind?: StatisticKind
): number {
  const r = restrict ?? null
  let m = 0
  for (let i = 0; i < values.length; i++) {
    if (isInMask(values[i], kind) && (r === null || r[i] !== 0)) m++
  }
  return m
}

/** A threshold that rejects every voxel, in the direction the gate compares:
 * p-maps keep v ≤ threshold (so −∞); all others keep |v|/v ≥ threshold (so +∞). */
function rejectAllThreshold(kind: StatisticKind): number {
  return kind === 'p' ? -Infinity : Infinity
}

/** t needs a positive dof; F needs both numerator and denominator. z/p need none. */
function hasValidDof(statistic: StatisticSpec): boolean {
  if (statistic.kind === 't') return statistic.dof1 >= 1
  if (statistic.kind === 'f') return statistic.dof1 >= 1 && statistic.dof2 >= 1
  return true
}

/** Result that hides every voxel — used when the statistic is unusable (missing
 * dof) or no voxel is significant. */
function rejectAllResult(kind: StatisticKind): CorrectionResult {
  return {
    statThreshold: rejectAllThreshold(kind),
    minClusterSize: null,
    mask: null,
    survivingVoxels: 0,
    smoothness: null,
    report: null,
    membership: null
  }
}

/** Cluster a survival mask and build the report plus its compact membership.
 * Region annotation is layered on later (on the main thread) so an atlas change
 * never re-runs correction. */
function reportFromMask(
  values: Float64Array,
  dims: [number, number, number],
  affine: Float64Array,
  mask: Uint8Array,
  connectivity: Connectivity,
  kind: StatisticKind
): { report: ClusterReport; membership: ClusterMembership } {
  const components = labelClusters(mask, dims, connectivity)
  const report = buildClusterReport(
    values,
    dims,
    affine,
    components,
    1,
    kind === 'p' ? 'minimum' : 'magnitude'
  )
  return { report, membership: buildMembership(report, components, dims) }
}

/** Compute the cluster-GRF survival mask + report, clustering each sign tail
 * separately so touching opposite-sign clusters stay distinct. */
function computeClusterGrf(
  req: CorrectionRequest,
  m: number,
  onProgress?: (stage: ProgressStage, fraction: number) => void
): {
  statThreshold: number
  minClusterSize: number
  mask: Uint8Array
  survivingVoxels: number
  smoothness: Smoothness
  report: ClusterReport | null
  membership: ClusterMembership | null
} {
  const {
    values,
    dims,
    affine,
    spacing,
    statistic,
    alpha,
    clusterFormingP,
    tail: requestedTail,
    connectivity
  } = req
  const tail = tailForStatistic(statistic.kind, requestedTail)
  const restrict = req.restrict ?? null
  const n = values.length
  const z = new Float64Array(n)
  const inMask = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (isInMask(values[i], statistic.kind) && (restrict === null || restrict[i] !== 0)) {
      inMask[i] = 1
      z[i] = statToZ(values[i], statistic.kind, statistic.dof1, statistic.dof2)
    }
  }

  onProgress?.('smoothness', 0)
  const smoothness = req.smoothnessOverride ?? estimateSmoothness(z, dims, inMask, spacing)
  const { zThreshold, minClusterSize } = clusterExtentThreshold({
    n: m,
    dLh: smoothness.dLh,
    voxelP: clusterFormingP,
    clusterP: alpha,
    tail
  })

  onProgress?.('clusters', 0)
  const posMask = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (inMask[i] && z[i] >= zThreshold) posMask[i] = 1
  const posComp = labelClusters(posMask, dims, connectivity)
  const negComp =
    tail === 'two'
      ? (() => {
          const negMask = new Uint8Array(n)
          for (let i = 0; i < n; i++) if (inMask[i] && z[i] <= -zThreshold) negMask[i] = 1
          return labelClusters(negMask, dims, connectivity)
        })()
      : null

  const mask = new Uint8Array(n)
  const combinedLabels = new Int32Array(n)
  const combinedSizes: number[] = []
  let nextId = 0
  const applyTail = (comp: Components): void => {
    const map = new Int32Array(comp.count + 1)
    for (let c = 1; c <= comp.count; c++) {
      if (comp.sizes[c - 1] >= minClusterSize) {
        map[c] = ++nextId
        combinedSizes.push(comp.sizes[c - 1])
      }
    }
    for (let i = 0; i < n; i++) {
      const label = comp.labels[i]
      if (label && map[label]) {
        combinedLabels[i] = map[label]
        mask[i] = 1
      }
    }
  }
  applyTail(posComp)
  if (negComp) applyTail(negComp)

  let survivingVoxels = 0
  for (let i = 0; i < n; i++) if (mask[i]) survivingVoxels++

  let report: ClusterReport | null = null
  let membership: ClusterMembership | null = null
  if (req.includeReport) {
    onProgress?.('report', 0)
    const components: Components = {
      labels: combinedLabels,
      sizes: Int32Array.from(combinedSizes),
      count: nextId
    }
    report = buildClusterReport(
      values,
      dims,
      affine,
      components,
      1,
      statistic.kind === 'p' ? 'minimum' : 'magnitude'
    )
    membership = buildMembership(report, components, dims)
  }

  const statThreshold = statCutoffForP(
    clusterFormingP,
    statistic.kind,
    statistic.dof1,
    statistic.dof2,
    tail
  )
  return { statThreshold, minClusterSize, mask, survivingVoxels, smoothness, report, membership }
}

/** Resolve a correction to its threshold, survival mask, and cluster report. */
export function computeCorrection(
  req: CorrectionRequest,
  onProgress?: (stage: ProgressStage, fraction: number) => void
): CorrectionResult {
  const { values, dims, affine, statistic, method, alpha, tail: requestedTail, connectivity } = req
  const { kind, dof1, dof2 } = statistic
  const tail = tailForStatistic(kind, requestedTail)
  const restrict = req.restrict ?? null

  // A t/F map with no (positive) degrees of freedom cannot yield valid p-values;
  // hide everything rather than emit garbage thresholds.
  if (!hasValidDof(statistic)) return rejectAllResult(kind)

  onProgress?.('scan', 0)
  const m = countInMask(values, restrict, kind)

  if (method === 'cluster-grf') {
    const grf = computeClusterGrf(req, m, onProgress)
    return {
      statThreshold: grf.statThreshold,
      minClusterSize: grf.minClusterSize,
      mask: grf.mask,
      survivingVoxels: grf.survivingVoxels,
      smoothness: grf.smoothness,
      report: grf.report,
      membership: grf.membership
    }
  }

  let statThreshold: number
  if (method === 'uncorrected') {
    statThreshold = statCutoffForP(alpha, kind, dof1, dof2, tail)
  } else if (method === 'bonferroni') {
    statThreshold = statCutoffForP(alpha / Math.max(m, 1), kind, dof1, dof2, tail)
  } else {
    // FDR: collect in-mask p-values, run Benjamini-Hochberg, map back to a cutoff.
    const pv = new Float64Array(m)
    let w = 0
    for (let i = 0; i < values.length; i++) {
      const v = values[i]
      if (isInMask(v, kind) && (restrict === null || restrict[i] !== 0)) {
        pv[w++] = statToP(v, kind, dof1, dof2, tail)
      }
    }
    const pThr = fdrThreshold(pv, m, alpha)
    // pThr < 0 means BH rejected nothing → hide everything (in the gate's own
    // direction). A pThr of exactly 0 is a real threshold (only p=0 voxels pass).
    statThreshold =
      pThr < 0 ? rejectAllThreshold(kind) : statCutoffForP(pThr, kind, dof1, dof2, tail)
  }

  let survivingVoxels = 0
  let report: ClusterReport | null = null
  let membership: ClusterMembership | null = null
  const survives = survivesPredicate(kind, tail, statThreshold)
  const inEff = (i: number): boolean =>
    isInMask(values[i], kind) && (restrict === null || restrict[i] !== 0)
  if (req.includeReport) {
    onProgress?.('clusters', 0)
    const survivalMask = new Uint8Array(values.length)
    for (let i = 0; i < values.length; i++) {
      if (inEff(i) && survives(values[i])) {
        survivalMask[i] = 1
        survivingVoxels++
      }
    }
    onProgress?.('report', 0)
    const built = reportFromMask(values, dims, affine, survivalMask, connectivity, kind)
    report = built.report
    membership = built.membership
  } else {
    for (let i = 0; i < values.length; i++) {
      if (inEff(i) && survives(values[i])) survivingVoxels++
    }
  }

  return {
    statThreshold,
    minClusterSize: null,
    // With a restriction, the display gate also needs to hide out-of-mask
    // voxels; the survival mask = restriction ∧ threshold, and the gate applies
    // the threshold, so returning the restriction mask itself is exactly right.
    mask: restrict,
    survivingVoxels,
    smoothness: null,
    report,
    membership
  }
}

export { countInMask }
