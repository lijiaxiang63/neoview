import { describe, expect, it } from 'vitest'
import fixture from './fixtures/grf-tail-reference.json'
import { computeCorrection, type CorrectionRequest } from '../src/renderer/src/stats/correctionCore'
import { normalInv, studentTSf } from '../src/renderer/src/stats/distributions'
import { statToZ } from '../src/renderer/src/stats/pValues'

const affine = new Float64Array(16)
affine[0] = affine[5] = affine[10] = affine[15] = 1
const lookup = new Map(Object.entries(fixture.zByT).map(([t, z]) => [Number(t), z]))
const request: CorrectionRequest = {
  values: Float64Array.from(fixture.values),
  dims: [30, 30, 30],
  affine,
  spacing: [1, 1, 1],
  statistic: { kind: 't', dof1: 379, dof2: 0 },
  method: 'cluster-grf',
  alpha: 0.05,
  clusterFormingP: 0.001,
  tail: 'two',
  connectivity: 26,
  includeReport: true
}

// Deliberately retain the pre-fix transform to demonstrate the native GRF bias.
function clippedZ(t: number): number {
  return Math.sign(t) * normalInv(1 - Math.max(1e-15, studentTSf(Math.abs(t), 379)))
}

describe('strong T regression (independent SciPy synthetic reference)', () => {
  it.each(fixture.tReferences)('df=%s T=%s matches SciPy Z=%s', (df, t, expected) => {
    expect(statToZ(t, 't', df, 0)).toBeCloseTo(expected, 9)
    expect(statToZ(-t, 't', df, 0)).toBeCloseTo(-expected, 9)
  })
  it.each(fixture.pReferences)('preserves representable p=%s', (p, expected) => {
    expect(statToZ(p, 'p', 0, 0)).toBeCloseTo(expected, 9)
  })
  it.each([
    // GrouVox PR #5: independent 50-digit mpmath values beyond sf underflow.
    [150, 39.4035461107778],
    [1000, 54.624470143243]
  ])('retains underflowed T=%s tails', (t, expected) => {
    expect(studentTSf(t, 379)).toBe(0)
    expect(statToZ(t, 't', 379, 0)).toBeCloseTo(expected, 9)
    expect(statToZ(-t, 't', 379, 0)).toBeCloseTo(-expected, 9)
  })
  it('is strictly increasing on a dense T grid through the old cap and sf underflow', () => {
    for (const df of [20, 379]) {
      let previous = 0
      for (let i = 1; i <= 4000; i++) {
        const z = statToZ(i / 20, 't', df, 0)
        expect(z).toBeGreaterThan(previous)
        previous = z
      }
    }
  })
  it('remains finite and increasing across the underflow boundary and huge finite T', () => {
    for (const df of [5, 20, 379, 1000]) {
      let last = 0
      for (const t of [
        0.1,
        2,
        9,
        19,
        40,
        100,
        120,
        125,
        130,
        150,
        200,
        1000,
        1e6,
        1e20,
        3.4028234663852886e38,
        1e200,
        Number.MAX_VALUE
      ]) {
        const z = statToZ(t, 't', df, 0)
        expect(Number.isFinite(z)).toBe(true)
        expect(z).toBeGreaterThan(last)
        last = z
      }
    }
    expect(statToZ(0, 't', 379, 0)).toBe(0)
    expect(Number.isFinite(statToZ(0, 'p', 0, 0))).toBe(true)
  })
  it.each([1, -1])('matches reference GRF with automatic smoothness, sign=%s', (sign) => {
    const actual = computeCorrection({ ...request, values: request.values.map((t) => sign * t) })
    const reference = computeCorrection({
      ...request,
      statistic: { kind: 'z', dof1: 0, dof2: 0 },
      values: Float64Array.from(fixture.values, (t) => sign * lookup.get(t)!)
    })
    const old = computeCorrection({
      ...request,
      statistic: { kind: 'z', dof1: 0, dof2: 0 },
      values: Float64Array.from(fixture.values, (t) => sign * clippedZ(t))
    })
    expect(actual.smoothness!.dLh).toBeCloseTo(reference.smoothness!.dLh, 10)
    actual.smoothness!.fwhm.forEach((v, axis) =>
      expect(v).toBeCloseTo(reference.smoothness!.fwhm[axis], 9)
    )
    expect(actual.minClusterSize).toBe(reference.minClusterSize)
    expect(actual.mask).toEqual(reference.mask)
    expect(Math.abs(old.smoothness!.dLh - actual.smoothness!.dLh)).toBeGreaterThan(0.001)
    expect(old.minClusterSize).not.toBe(actual.minClusterSize)
    expect(actual.minClusterSize).toBe(38)
    expect(old.minClusterSize).toBe(41)
  })
  it.each(['one', 'two'] as const)('honors external smoothness (%s tail)', (tail) => {
    const smoothnessOverride = { fwhm: [6, 6, 6] as [number, number, number], dLh: 0.005 }
    const actual = computeCorrection({ ...request, tail, smoothnessOverride })
    const old = computeCorrection({
      ...request,
      tail,
      smoothnessOverride,
      statistic: { kind: 'z', dof1: 0, dof2: 0 },
      values: Float64Array.from(fixture.values, clippedZ)
    })
    expect(actual.smoothness).toEqual(smoothnessOverride)
    expect(actual.minClusterSize).toBe(old.minClusterSize)
    expect(actual.mask).toEqual(old.mask)
  })
})
