/* eslint-disable no-loss-of-precision -- Cephes/Acklam/Lanczos reference
   constants keep extra guard digits on purpose; the nearest double is the
   intended value. */
// Pure statistical distribution functions, hand-written because the renderer
// carries no math/stats dependency. Ported to match the reference Python
// (scipy.stats) results the correction pipeline is validated against:
//   - erf/erfc via the Cephes rational approximation (~1e-15),
//   - log-gamma via Lanczos (g=7, ~1e-15),
//   - the regularized incomplete beta via the Lentz continued fraction,
//   - the normal quantile via Acklam's approximation refined by one Halley step.
// Everything here is a pure function of scalars — trivially unit-testable.

/** Γ(2.5) = (3/4)·√π, the only gamma value the D=3 cluster-extent math needs. */
export const GAMMA_2_5 = 1.329340388179137

const SQRT2 = Math.SQRT2
const SQRT2PI = Math.sqrt(2 * Math.PI)
const MAXLOG = 709.782712893384

function polevl(x: number, coef: number[]): number {
  let result = coef[0]
  for (let i = 1; i < coef.length; i++) result = result * x + coef[i]
  return result
}

/** Horner evaluation of a polynomial whose leading coefficient is an implied 1. */
function p1evl(x: number, coef: number[]): number {
  let result = x + coef[0]
  for (let i = 1; i < coef.length; i++) result = result * x + coef[i]
  return result
}

const ERF_T = [
  9.60497373987051638749, 9.0026019720384268921e1, 2.23200534594684319226e3,
  7.00332514112805075473e3, 5.55923013010394962768e4
]
const ERF_U = [
  3.35617141647503099647e1, 5.21357949780152679795e2, 4.59432382970980127987e3,
  2.26290000613890934246e4, 4.92673942608635921086e4
]
const ERFC_P = [
  2.46196981473530512524e-10, 5.64189564831068821977e-1, 7.46321056442269912687,
  4.86371970985681366614e1, 1.96520832956077098242e2, 5.26445194995477358631e2,
  9.3452852717195760754e2, 1.02755188689515710272e3, 5.57535335369399327526e2
]
const ERFC_Q = [
  1.32281951154744992508e1, 8.67072140885989742329e1, 3.54937778887819891062e2,
  9.75708501743205489753e2, 1.82390916687909736289e3, 2.24633760818710981792e3,
  1.65666309194161350182e3, 5.57535340817727675546e2
]
const ERFC_R = [
  5.64189583547755073984e-1, 1.27536670759978104416, 5.01905042251180477414, 6.16021097993053585195,
  7.4097426995044893916, 2.9788666537210024067
]
const ERFC_S = [
  2.2605286322011727659, 9.39603524938001434673, 1.20489539808096656605e1, 1.70814450747565897222e1,
  9.60896809063285878198, 3.3690764510008151605
]

/** Complementary error function erfc(x) = 1 − erf(x), Cephes rational form. */
export function erfc(a: number): number {
  const x = Math.abs(a)
  if (x < 1) return 1 - erf(a)
  let z = -a * a
  if (z < -MAXLOG) return a < 0 ? 2 : 0
  z = Math.exp(z)
  let p: number
  let q: number
  if (x < 8) {
    p = polevl(x, ERFC_P)
    q = p1evl(x, ERFC_Q)
  } else {
    p = polevl(x, ERFC_R)
    q = p1evl(x, ERFC_S)
  }
  let y = (z * p) / q
  if (a < 0) y = 2 - y
  if (y === 0) return a < 0 ? 2 : 0
  return y
}

/** Error function erf(x), Cephes rational form. */
export function erf(x: number): number {
  if (Math.abs(x) > 1) return 1 - erfc(x)
  const z = x * x
  return (x * polevl(z, ERF_T)) / p1evl(z, ERF_U)
}

/** Standard-normal CDF Φ(z) = P(Z ≤ z). */
export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / SQRT2)
}

/** Standard-normal survival P(Z > z), computed via erfc so the far tail keeps
 * full precision (needed for tiny Bonferroni / cluster-forming thresholds). */
export function normalSf(z: number): number {
  return 0.5 * erfc(z / SQRT2)
}

const ACKLAM_A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
  -3.066479806614716e1, 2.506628277459239
]
const ACKLAM_B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
  -1.328068155288572e1
]
const ACKLAM_C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
  4.374664141464968, 2.938163982698783
]
const ACKLAM_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]

/** Inverse standard-normal CDF (probit): Acklam's rational approximation
 * refined by a single Halley iteration → ~1e-15. p outside (0,1) → ±∞. */
export function normalInv(p: number): number {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  const pLow = 0.02425
  const pHigh = 1 - pLow
  let x: number
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p))
    x =
      (((((ACKLAM_C[0] * q + ACKLAM_C[1]) * q + ACKLAM_C[2]) * q + ACKLAM_C[3]) * q + ACKLAM_C[4]) *
        q +
        ACKLAM_C[5]) /
      ((((ACKLAM_D[0] * q + ACKLAM_D[1]) * q + ACKLAM_D[2]) * q + ACKLAM_D[3]) * q + 1)
  } else if (p <= pHigh) {
    const q = p - 0.5
    const r = q * q
    x =
      ((((((ACKLAM_A[0] * r + ACKLAM_A[1]) * r + ACKLAM_A[2]) * r + ACKLAM_A[3]) * r +
        ACKLAM_A[4]) *
        r +
        ACKLAM_A[5]) *
        q) /
      (((((ACKLAM_B[0] * r + ACKLAM_B[1]) * r + ACKLAM_B[2]) * r + ACKLAM_B[3]) * r + ACKLAM_B[4]) *
        r +
        1)
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    x =
      -(
        ((((ACKLAM_C[0] * q + ACKLAM_C[1]) * q + ACKLAM_C[2]) * q + ACKLAM_C[3]) * q +
          ACKLAM_C[4]) *
          q +
        ACKLAM_C[5]
      ) /
      ((((ACKLAM_D[0] * q + ACKLAM_D[1]) * q + ACKLAM_D[2]) * q + ACKLAM_D[3]) * q + 1)
  }
  // One Halley step against Φ to reach full double precision.
  const e = normalCdf(x) - p
  const u = e * SQRT2PI * Math.exp((x * x) / 2)
  return x - u / (1 + (x * u) / 2)
}

const LANCZOS_G = 7
const LANCZOS_C = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7
]

/** Natural log of the gamma function, Lanczos (g=7) with the reflection
 * formula for x < 0.5. */
export function lnGamma(x: number): number {
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x)
  }
  x -= 1
  let a = LANCZOS_C[0]
  const t = x + LANCZOS_G + 0.5
  for (let i = 1; i < LANCZOS_C.length; i++) a += LANCZOS_C[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

const BETACF_MAXIT = 300
const BETACF_EPS = 1e-15
const BETACF_FPMIN = 1e-300

/** Continued-fraction expansion for the incomplete beta (Lentz's method). */
function betacf(a: number, b: number, x: number): number {
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < BETACF_FPMIN) d = BETACF_FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= BETACF_MAXIT; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < BETACF_FPMIN) d = BETACF_FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < BETACF_FPMIN) c = BETACF_FPMIN
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < BETACF_FPMIN) d = BETACF_FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < BETACF_FPMIN) c = BETACF_FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < BETACF_EPS) break
  }
  return h
}

/**
 * Regularized incomplete beta I_x(a,b) ∈ [0,1]. Uses the standard
 * x < (a+1)/(a+b+2) reflection so the continued fraction always converges fast.
 */
export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const lbeta = lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  const front = Math.exp(lbeta)
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betacf(a, b, x)) / a
  }
  return 1 - (front * betacf(b, a, 1 - x)) / b
}

/** Student-t survival P(T > t) with `dof` degrees of freedom. */
export function studentTSf(t: number, dof: number): number {
  if (!Number.isFinite(t)) return t > 0 ? 0 : 1
  const x = dof / (dof + t * t)
  // I_x(dof/2, 1/2) = P(|T| > |t|).
  const twoTail = regularizedIncompleteBeta(dof / 2, 0.5, x)
  return t >= 0 ? 0.5 * twoTail : 1 - 0.5 * twoTail
}

/** F-distribution survival P(F > f) with (d1, d2) degrees of freedom. */
export function fSf(f: number, d1: number, d2: number): number {
  if (f <= 0) return 1
  const x = d2 / (d2 + d1 * f)
  return regularizedIncompleteBeta(d2 / 2, d1 / 2, x)
}
