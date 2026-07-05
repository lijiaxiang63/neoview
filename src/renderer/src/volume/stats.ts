import type { VolumeStats, VoxelArray } from './types'

const INT_RANGES: Record<number, [number, number]> = {
  2: [0, 255],
  4: [-32768, 32767],
  8: [-2147483648, 2147483647],
  256: [-128, 127],
  512: [0, 65535],
  768: [0, 4294967295]
}

const HIST_BINS = 8192

/** Offsets that shift 1/2-byte integer values into non-negative counting indices. */
const COUNT_OFFSETS: Record<number, [offset: number, size: number]> = {
  2: [0, 256], // uint8
  256: [128, 256], // int8
  4: [32768, 65536], // int16
  512: [0, 65536] // uint16
}

/**
 * Narrow integer types get a single exact counting pass: one read per voxel
 * yields min, max, AND exact percentiles — about half the cost of the
 * generic min/max + histogram double pass, with no binning error.
 */
function countingStats(
  raw: VoxelArray,
  offset: number,
  size: number
): { min: number; max: number; pick: (q: number) => number } {
  const counts = new Uint32Array(size)
  const n = raw.length
  for (let i = 0; i < n; i++) counts[raw[i] + offset]++
  let min = 0
  let max = size - 1
  while (min < size && counts[min] === 0) min++
  while (max > 0 && counts[max] === 0) max--
  if (min > max) {
    min = 0
    max = 0
  }
  const pick = (q: number): number => {
    const target = q * n
    let acc = 0
    for (let b = min; b <= max; b++) {
      acc += counts[b]
      if (acc >= target) return b - offset
    }
    return max - offset
  }
  return { min: min - offset, max: max - offset, pick }
}

export function computeStats(
  raw: VoxelArray,
  slope: number,
  inter: number,
  datatypeCode: number
): VolumeStats {
  const n = raw.length
  const counting = COUNT_OFFSETS[datatypeCode]
  if (counting && n > 0) {
    const { min, max, pick } = countingStats(raw, counting[0], counting[1])
    const toScaled = (v: number): number => v * slope + inter
    const lo = toScaled(min)
    const hi = toScaled(max)
    const q2 = toScaled(pick(0.02))
    const q98 = toScaled(pick(0.98))
    const intRange = INT_RANGES[datatypeCode] ?? null
    return {
      dataMin: Math.min(lo, hi),
      dataMax: Math.max(lo, hi),
      p2: Math.min(q2, q98),
      p98: Math.max(q2, q98),
      typeRange: intRange
        ? ([
            Math.min(toScaled(intRange[0]), toScaled(intRange[1])),
            Math.max(toScaled(intRange[0]), toScaled(intRange[1]))
          ] as [number, number])
        : null
    }
  }
  // Integer arrays can never hold NaN/Infinity, so the per-voxel finiteness
  // check (a real cost at 16M+ voxels) is only paid for float datatypes.
  const mayBeNonFinite = datatypeCode === 16 || datatypeCode === 64

  // Exact min/max over every voxel. A strided sample is unsafe here: when the
  // stride happens to be near a dimension's pitch it aliases onto a narrow,
  // unrepresentative band (e.g. one edge column), which collapses the range and
  // pushes the percentiles far off — leaving the display blown out or flat.
  let min = Infinity
  let max = -Infinity
  if (mayBeNonFinite) {
    for (let i = 0; i < n; i++) {
      const v = raw[i]
      if (!Number.isFinite(v)) continue
      if (v < min) min = v
      if (v > max) max = v
    }
  } else {
    for (let i = 0; i < n; i++) {
      const v = raw[i]
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (min > max) {
    min = 0
    max = 0
  }

  // Percentiles from a full-pass histogram over [min, max]. Still one linear
  // scan, but every voxel is counted, so the distribution is faithful whatever
  // the volume's shape.
  const span = max - min
  let pickRaw: (q: number) => number
  if (span > 0) {
    const hist = new Uint32Array(HIST_BINS)
    const binScale = (HIST_BINS - 1) / span
    let total = 0
    if (mayBeNonFinite) {
      for (let i = 0; i < n; i++) {
        const v = raw[i]
        if (!Number.isFinite(v)) continue
        hist[((v - min) * binScale) | 0]++
        total++
      }
    } else {
      for (let i = 0; i < n; i++) {
        hist[((raw[i] - min) * binScale) | 0]++
      }
      total = n
    }
    const binWidth = span / (HIST_BINS - 1)
    pickRaw = (q) => {
      const target = q * total
      let acc = 0
      for (let b = 0; b < HIST_BINS; b++) {
        acc += hist[b]
        if (acc >= target) return min + b * binWidth
      }
      return max
    }
  } else {
    pickRaw = () => min
  }

  const toScaled = (v: number): number => v * slope + inter
  const lo = toScaled(min)
  const hi = toScaled(max)
  const q2 = toScaled(pickRaw(0.02))
  const q98 = toScaled(pickRaw(0.98))

  const intRange = INT_RANGES[datatypeCode] ?? null
  return {
    dataMin: Math.min(lo, hi),
    dataMax: Math.max(lo, hi),
    p2: Math.min(q2, q98),
    p98: Math.max(q2, q98),
    typeRange: intRange
      ? ([
          Math.min(toScaled(intRange[0]), toScaled(intRange[1])),
          Math.max(toScaled(intRange[0]), toScaled(intRange[1]))
        ] as [number, number])
      : null
  }
}
