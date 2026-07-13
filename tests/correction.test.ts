import { describe, expect, it } from 'vitest'
import { fdrThreshold } from '../src/renderer/src/stats/correction'

describe('fdrThreshold (Benjamini-Hochberg)', () => {
  it('reproduces the canonical 15-p-value example at q=0.05', () => {
    // Benjamini & Hochberg (1995): rejects the first four, threshold p=0.0095.
    const p = new Float64Array([
      0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344, 0.0459, 0.324, 0.4262, 0.5719,
      0.6528, 0.759, 1.0
    ])
    const threshold = fdrThreshold(p, p.length, 0.05)
    expect(threshold).toBeCloseTo(0.0095, 12)
    const significant = [...p].filter((v) => v <= threshold).length
    expect(significant).toBe(4)
  })

  it('finds the largest surviving rank even past non-surviving gaps', () => {
    // p=0.04 at rank 1 fails (0.04 > 0.025) but rank 2 (0.045 ≤ 0.05) survives.
    const p = new Float64Array([0.04, 0.045])
    expect(fdrThreshold(p, 2, 0.05)).toBeCloseTo(0.045, 12)
  })

  it('returns −1 (no rejection) — distinct from a real threshold of 0', () => {
    expect(fdrThreshold(new Float64Array([0.9, 0.95]), 2, 0.05)).toBe(-1)
    expect(fdrThreshold(new Float64Array([]), 0, 0.05)).toBe(-1)
    // All-zero p-values ARE all rejected → the real threshold is 0, not −1.
    expect(fdrThreshold(new Float64Array([0, 0, 0]), 3, 0.05)).toBe(0)
  })

  it('sorts the input in place (caller owns the scratch buffer)', () => {
    const p = new Float64Array([0.3, 0.001, 0.1])
    fdrThreshold(p, 3, 0.05)
    expect([...p]).toEqual([0.001, 0.1, 0.3])
  })
})
