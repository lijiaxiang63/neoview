import { describe, expect, it } from 'vitest'
import { estimateSmoothness } from '../src/renderer/src/stats/smoothness'

const near = (a: number, b: number, tol: number): void => {
  expect(Math.abs(a - b)).toBeLessThan(tol)
}

function checkerboard(dims: [number, number, number]): Float64Array {
  const [nx, ny, nz] = dims
  const values = new Float64Array(nx * ny * nz)
  let idx = 0
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, idx++) {
        values[idx] = (i + j + k) % 2 === 0 ? 1 : -1
      }
    }
  }
  return values
}

describe('estimateSmoothness', () => {
  const dims: [number, number, number] = [6, 6, 6]
  const mask = new Uint8Array(6 * 6 * 6).fill(1)

  it('recovers the closed-form values for an anti-correlated field', () => {
    // Fully anti-correlated neighbors → rho clamps to 1e-15, giving a fixed
    // sigma² and FWHM per axis and a fixed dLh.
    const values = checkerboard(dims)
    const { fwhm, dLh } = estimateSmoothness(values, dims, mask, [1, 1, 1])
    for (const f of fwhm) near(f, 0.20035, 1e-3)
    near(dLh, 574.1, 1.5)
  })

  it('FWHM scales linearly with voxel spacing', () => {
    const values = checkerboard(dims)
    const iso = estimateSmoothness(values, dims, mask, [1, 1, 1])
    const aniso = estimateSmoothness(values, dims, mask, [2, 1, 1])
    near(aniso.fwhm[0], 2 * iso.fwhm[0], 1e-6)
    near(aniso.fwhm[1], iso.fwhm[1], 1e-6)
    // dLh is a resolution-element density in voxel units — spacing-independent.
    near(aniso.dLh, iso.dLh, 1e-9)
  })

  it('a constant field hits the |rho|→1 guard without NaN/Inf', () => {
    const values = new Float64Array(6 * 6 * 6).fill(3)
    const { fwhm, dLh } = estimateSmoothness(values, dims, mask, [1, 1, 1])
    for (const f of fwhm) expect(Number.isFinite(f)).toBe(true)
    expect(Number.isFinite(dLh)).toBe(true)
  })
})
