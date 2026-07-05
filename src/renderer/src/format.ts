/** Compact numeric readout: plain for mid-range values, exponential otherwise. */
export function fmt(v: number): string {
  if (v === 0) return '0'
  const abs = Math.abs(v)
  if (abs >= 1000 || abs < 0.01) return v.toExponential(2)
  return Number(v.toFixed(2)).toString()
}
