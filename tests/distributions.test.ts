import { describe, expect, it } from 'vitest'
import {
  GAMMA_2_5,
  erf,
  erfc,
  fSf,
  lnGamma,
  normalCdf,
  normalInv,
  normalSf,
  regularizedIncompleteBeta,
  studentTSf
} from '../src/renderer/src/stats/distributions'

const near = (a: number, b: number, tol: number): void => {
  expect(Math.abs(a - b)).toBeLessThan(tol)
}

describe('erf / erfc', () => {
  it('matches reference values', () => {
    near(erf(0), 0, 1e-15)
    near(erf(1), 0.8427007929497148, 1e-12)
    near(erfc(2), 0.0046777349810472645, 1e-12)
    near(erf(-1), -0.8427007929497148, 1e-12)
  })
  it('erf and erfc are complementary across the range', () => {
    for (const x of [-3, -0.5, 0.3, 1.5, 4]) near(erf(x) + erfc(x), 1, 1e-12)
  })
})

describe('normal CDF / SF / inverse', () => {
  it('matches reference values', () => {
    near(normalCdf(1.96), 0.9750021048517796, 1e-12)
    near(normalCdf(0), 0.5, 1e-15)
    near(normalSf(6), 9.865877004244794e-10, 1e-16)
    near(normalInv(0.975), 1.9599639845400534, 1e-9)
    near(normalInv(1e-8), -5.612001244174788, 1e-6)
  })
  it('normalInv inverts normalCdf', () => {
    for (const z of [-4, -1.5, -0.2, 0.7, 2.3, 5]) near(normalInv(normalCdf(z)), z, 1e-9)
  })
  it('normalSf is the tail complement of normalCdf', () => {
    for (const z of [-2, 0, 1, 3]) near(normalCdf(z) + normalSf(z), 1, 1e-12)
  })
})

describe('regularizedIncompleteBeta', () => {
  it('matches the closed-form I_0.5(2,3) = 0.6875', () => {
    near(regularizedIncompleteBeta(2, 3, 0.5), 0.6875, 1e-12)
  })
  it('respects the endpoints', () => {
    expect(regularizedIncompleteBeta(2, 3, 0)).toBe(0)
    expect(regularizedIncompleteBeta(2, 3, 1)).toBe(1)
  })
  it('lnGamma matches known integer factorials', () => {
    near(lnGamma(5), Math.log(24), 1e-10) // Γ(5)=4!
    near(lnGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-10)
  })
})

describe('Student-t and F survival', () => {
  it('matches integrated t survival oracles', () => {
    near(studentTSf(2.0, 10), 0.03669401738536185, 1e-6)
    near(2 * studentTSf(2.2281388519649385, 10), 0.05, 1e-6)
    near(studentTSf(3.0, 30), 0.002694982032824757, 1e-7)
    near(studentTSf(0, 10), 0.5, 1e-12)
  })
  it('matches integrated F survival oracles', () => {
    near(fSf(3.0, 3, 10), 0.08174695180982043, 1e-6)
    near(fSf(2.71088, 5, 20), 0.05, 1e-4)
    // F(1, df) equals the two-tailed t: fSf(t², 1, df) = 2·studentTSf(t, df)
    near(fSf(2.2281388519649385 ** 2, 1, 10), 2 * studentTSf(2.2281388519649385, 10), 1e-9)
    expect(fSf(0, 3, 10)).toBe(1)
  })
})

describe('constants', () => {
  it('GAMMA_2_5 = (3/4)·√π', () => {
    near(GAMMA_2_5, 0.75 * Math.sqrt(Math.PI), 1e-15)
  })
})
