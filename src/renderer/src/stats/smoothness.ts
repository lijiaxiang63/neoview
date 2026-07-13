// Spatial-smoothness estimate (per-axis FWHM and the resolution-element density
// dLh) from a single statistic/z map, using the FSL/DPABI lag-1 autocorrelation
// method. This is the residual-free variant — it estimates roughness from the
// map itself and applies no degrees-of-freedom scaling, so it is an
// approximation of a residual-based estimate. Pure.

export interface Smoothness {
  /** Per-axis full-width-half-maximum in world units. */
  fwhm: [number, number, number]
  /** Resolution-element density (√|Λ|), the quantity the cluster-extent math needs. */
  dLh: number
}

const EIGHT_LN2 = 8 * Math.log(2)
const SQRT8 = Math.sqrt(8)

/**
 * Estimate smoothness of `values` over the in-mask voxels. For each axis it
 * accumulates lag-1 neighbor products over pairs both inside the mask:
 *   rho = Σ(a·b) / Σ½(a²+b²),  σ² = −1/(4·ln|rho|),
 *   FWHM = √(8·ln2·σ²)·spacing,  dLh = (σ₀²·σ₁²·σ₂²)^(−½)/√8.
 */
export function estimateSmoothness(
  values: Float64Array,
  dims: [number, number, number],
  inMask: Uint8Array,
  spacing: [number, number, number]
): Smoothness {
  const [nx, ny, nz] = dims
  const sy = nx
  const sz = nx * ny
  const ssMinus = [0, 0, 0]
  const ssTotal = [0, 0, 0]

  let idx = 0
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, idx++) {
        if (!inMask[idx]) continue
        const a = values[idx]
        // A non-finite value would poison the whole estimate (NaN propagates and
        // silently collapses the cluster-size threshold), so skip such pairs.
        if (!Number.isFinite(a)) continue
        if (i + 1 < nx && inMask[idx + 1]) {
          const b = values[idx + 1]
          if (Number.isFinite(b)) {
            ssMinus[0] += a * b
            ssTotal[0] += 0.5 * (a * a + b * b)
          }
        }
        if (j + 1 < ny && inMask[idx + sy]) {
          const b = values[idx + sy]
          if (Number.isFinite(b)) {
            ssMinus[1] += a * b
            ssTotal[1] += 0.5 * (a * a + b * b)
          }
        }
        if (k + 1 < nz && inMask[idx + sz]) {
          const b = values[idx + sz]
          if (Number.isFinite(b)) {
            ssMinus[2] += a * b
            ssTotal[2] += 0.5 * (a * a + b * b)
          }
        }
      }
    }
  }

  const sigmaSq: [number, number, number] = [1, 1, 1]
  const fwhm: [number, number, number] = [0, 0, 0]
  for (let axis = 0; axis < 3; axis++) {
    if (ssTotal[axis] > 0) {
      let rho = ssMinus[axis] / ssTotal[axis]
      rho = Math.min(Math.max(rho, 1e-15), 1 - 1e-15)
      sigmaSq[axis] = -1 / (4 * Math.log(Math.abs(rho)))
    }
    fwhm[axis] = Math.sqrt(EIGHT_LN2 * sigmaSq[axis]) * spacing[axis]
  }

  const dLh = (sigmaSq[0] * sigmaSq[1] * sigmaSq[2]) ** -0.5 / SQRT8
  return { fwhm, dLh }
}
