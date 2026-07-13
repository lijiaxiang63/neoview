// Multiple-comparison correction methods. Each resolves to a single stat-space
// threshold (cluster-GRF additionally to a minimum cluster size); the shared
// display gate then keeps voxels whose |stat| clears the threshold. Pure.

export type CorrectionMethod = 'uncorrected' | 'bonferroni' | 'fdr' | 'cluster-grf'

/**
 * Benjamini-Hochberg step-up threshold over a set of p-values. Sorts `pValues`
 * ascending **in place** (the caller owns the scratch array), finds the largest
 * rank k with p₍ₖ₎ ≤ (k/m)·q, and returns that p₍ₖ₎ — the corrected p-threshold.
 * Returns **−1** when nothing is rejected — distinct from a legitimate threshold
 * of 0 (which occurs when the surviving p-values are exactly 0). `m` is the
 * number of tests (usually pValues.length, but passed explicitly so callers can
 * share one scratch buffer).
 */
export function fdrThreshold(pValues: Float64Array, m: number, q: number): number {
  const len = pValues.length
  if (len === 0 || m <= 0) return -1
  pValues.sort()
  let threshold = -1
  const scale = q / m
  for (let i = 0; i < len; i++) {
    if (pValues[i] <= (i + 1) * scale) threshold = pValues[i]
  }
  return threshold
}
