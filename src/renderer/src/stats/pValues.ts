// Conversions between a statistic value, its p-value, and its z-equivalent.
// A statistic map may hold Student-t, standard-normal (z), F, or p values;
// the correction methods work in p-space, the cluster-extent math works in
// z-space, and the display gate works in stat magnitude — these helpers bridge
// all three. Pure; depend only on distributions.ts.

import { fSf, normalInv, normalSf, studentTSf } from './distributions'

import type { StatisticKind } from '../volume/types'

export type { StatisticKind }
export type Tail = 'two' | 'one'

/** Clamp a probability into [1e-15, 1−1e-15]. The 1e-15 floor keeps `1 − p`
 * strictly below 1 so normalInv(1 − p) stays finite even for extreme statistics
 * (a t/z above ~8 otherwise rounds `1 − p` to exactly 1 → Infinity). Capping the
 * z-equivalent at ~8 is harmless: such voxels are astronomically significant and
 * always clear any cluster-forming threshold. */
function clampP(p: number): number {
  if (p < 1e-15) return 1e-15
  if (p > 1 - 1e-15) return 1 - 1e-15
  return p
}

/**
 * p-value for one statistic value. F is inherently one-sided (F ≥ 0), so `tail`
 * is ignored for it; a 'p' map is returned as-is (clamped to [0,1]).
 */
export function statToP(
  value: number,
  kind: StatisticKind,
  dof1: number,
  dof2: number,
  tail: Tail
): number {
  switch (kind) {
    case 'z':
      return tail === 'two' ? Math.min(1, 2 * normalSf(Math.abs(value))) : normalSf(value)
    case 't':
      return tail === 'two'
        ? Math.min(1, 2 * studentTSf(Math.abs(value), dof1))
        : studentTSf(value, dof1)
    case 'f':
      return fSf(value, dof1, dof2)
    case 'p':
      return value < 0 ? 0 : value > 1 ? 1 : value
  }
}

/**
 * z-equivalent (same upper-tail probability under N(0,1)), sign preserved for
 * signed statistics. Matches the reference `_t_to_z`: p is the one-sided tail of
 * the magnitude, clipped to [1e-300, 1−1e-15], then z = Φ⁻¹(1−p).
 */
export function statToZ(value: number, kind: StatisticKind, dof1: number, dof2: number): number {
  switch (kind) {
    case 'z':
      return value
    case 't': {
      const z = normalInv(1 - clampP(studentTSf(Math.abs(value), dof1)))
      return value >= 0 ? z : -z
    }
    case 'f':
      return normalInv(1 - clampP(fSf(value, dof1, dof2)))
    case 'p':
      return normalInv(1 - clampP(value))
  }
}

/** Bisection for the positive root of a monotonically decreasing survival fn. */
function invertDecreasing(sf: (x: number) => number, target: number): number {
  if (target >= sf(0)) return 0
  let lo = 0
  let hi = 1
  while (sf(hi) > target && hi < 1e6) hi *= 2
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2
    if (sf(mid) > target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * Stat-magnitude cutoff whose tail probability equals p — inverts statToP so
 * uncorrected/Bonferroni thresholds need no data pass. Two-tailed t/z solve for
 * the per-tail probability p/2; F is one-sided. For a 'p' map the "cutoff" is the
 * p threshold itself (the caller compares value ≤ threshold).
 */
export function statCutoffForP(
  p: number,
  kind: StatisticKind,
  dof1: number,
  dof2: number,
  tail: Tail
): number {
  const target = tail === 'two' && kind !== 'f' ? p / 2 : p
  switch (kind) {
    case 'z':
      // Invert the survival function directly (not normalInv(1−target)) so a
      // target of 0 yields the finite tail-underflow cutoff instead of Infinity.
      return invertDecreasing((x) => normalSf(x), target)
    case 't':
      return invertDecreasing((x) => studentTSf(x, dof1), target)
    case 'f':
      return invertDecreasing((x) => fSf(x, dof1, dof2), target)
    case 'p':
      return p
  }
}
