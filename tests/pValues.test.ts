import { describe, expect, it } from 'vitest'
import {
  statCutoffForP,
  statToP,
  statToZ,
  tailForStatistic
} from '../src/renderer/src/stats/pValues'

const near = (a: number, b: number, tol: number): void => {
  expect(Math.abs(a - b)).toBeLessThan(tol)
}

describe('tailForStatistic', () => {
  it('forces F and p values to one tail', () => {
    expect(tailForStatistic('f', 'two')).toBe('one')
    expect(tailForStatistic('p', 'two')).toBe('one')
    expect(tailForStatistic('t', 'two')).toBe('two')
    expect(tailForStatistic('z', 'one')).toBe('one')
  })
})

describe('statToP', () => {
  it('z two-tailed vs one-tailed', () => {
    near(statToP(1.959963984540054, 'z', 0, 0, 'two'), 0.05, 1e-9)
    near(statToP(1.959963984540054, 'z', 0, 0, 'one'), 0.025, 1e-9)
    near(statToP(-1.959963984540054, 'z', 0, 0, 'two'), 0.05, 1e-9)
  })
  it('t two-tailed critical value', () => {
    near(statToP(2.2281388519649385, 't', 10, 0, 'two'), 0.05, 1e-6)
  })
  it('F one-sided', () => {
    near(statToP(3.0, 'f', 3, 10, 'two'), 0.08174695180982043, 1e-6)
  })
  it('p passes through clamped', () => {
    expect(statToP(0.3, 'p', 0, 0, 'two')).toBe(0.3)
    expect(statToP(-1, 'p', 0, 0, 'two')).toBe(0)
    expect(statToP(2, 'p', 0, 0, 'two')).toBe(1)
  })
})

describe('statToZ', () => {
  it('z is identity', () => {
    expect(statToZ(1.23, 'z', 0, 0)).toBe(1.23)
  })
  it('t preserves sign and maps to equal-tail z', () => {
    const zPos = statToZ(2.0, 't', 10, 0)
    const zNeg = statToZ(-2.0, 't', 10, 0)
    near(zPos, -zNeg, 1e-12)
    expect(zPos).toBeGreaterThan(0)
    // t=2, df=10 → one-sided p≈0.0367 → z=Φ⁻¹(1−p)
    near(zPos, 1.7904099322689326, 1e-4)
  })
  it('clips extreme values without producing infinities', () => {
    expect(Number.isFinite(statToZ(1000, 't', 5, 0))).toBe(true)
  })
})

describe('statCutoffForP', () => {
  it('inverts statToP for z', () => {
    for (const p of [0.05, 0.01, 0.001]) {
      const cut = statCutoffForP(p, 'z', 0, 0, 'two')
      near(statToP(cut, 'z', 0, 0, 'two'), p, 1e-9)
    }
  })
  it('inverts statToP for t (two-tailed)', () => {
    for (const [p, dof] of [
      [0.05, 8],
      [0.01, 30],
      [0.001, 12]
    ]) {
      const cut = statCutoffForP(p, 't', dof, 0, 'two')
      near(statToP(cut, 't', dof, 0, 'two'), p, 1e-6)
    }
  })
  it('reproduces the z two-tailed critical value', () => {
    near(statCutoffForP(0.05, 'z', 0, 0, 'two'), 1.959963984540054, 1e-9)
    near(statCutoffForP(0.001, 'z', 0, 0, 'two'), 3.2905267314919247, 1e-8)
  })
  it('inverts statToP for F (one-sided)', () => {
    const cut = statCutoffForP(0.05, 'f', 3, 10, 'two')
    near(statToP(cut, 'f', 3, 10, 'two'), 0.05, 1e-5)
  })
})
