import { describe, expect, it } from 'vitest'
import {
  AUTO_THRESHOLD_FALLBACK,
  boxExtent,
  boxHistogram,
  boxStats,
  boxVoxelCount,
  clampBox,
  constraintFromLabelMap,
  constraintFromVolume,
  dilatedBox,
  OTSU_FLOOR,
  otsuThreshold,
  segmentRegion,
  wholeVolumeBox,
  type EngineParams,
  type SegBox
} from '../src/renderer/src/segmentation/segment'
import type { Volume } from '../src/renderer/src/volume/types'

function identity(): Float64Array {
  const m = new Float64Array(16)
  m[0] = m[5] = m[10] = m[15] = 1
  return m
}

function makeVolume(
  dims: [number, number, number],
  value: (i: number, j: number, k: number) => number
): Volume {
  const [nx, ny, nz] = dims
  const raw = new Float32Array(nx * ny * nz)
  let idx = 0
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, idx++) raw[idx] = value(i, j, k)
    }
  }
  return {
    name: 'synthetic',
    dims,
    frames: 1,
    spacing: [1, 1, 1],
    datatypeCode: 16,
    datatypeName: 'float32',
    raw,
    slope: 1,
    inter: 0,
    affine: identity(),
    transformSource: 'spacing-fallback',
    suggestedRange: null,
    labels: null,
    stats: { dataMin: 0, dataMax: 0, p2: 0, p98: 0, typeRange: null }
  }
}

const box = (min: [number, number, number], max: [number, number, number]): SegBox => ({
  min,
  max
})

const params = (
  over: Partial<EngineParams> & Pick<EngineParams, 'low' | 'high'>
): EngineParams => ({
  connectivity: 6,
  minVoxels: 1,
  ...over
})

/** Voxels selected by a result, as global "i,j,k" strings. */
function selected(vol: Volume, res: { mask: Uint8Array; bounds: SegBox }): Set<string> {
  const out = new Set<string>()
  const [bw, bh] = boxExtent(res.bounds)
  for (let p = 0; p < res.mask.length; p++) {
    if (res.mask[p] === 0) continue
    const i = (p % bw) + res.bounds.min[0]
    const j = (((p / bw) | 0) % bh) + res.bounds.min[1]
    const k = ((p / (bw * bh)) | 0) + res.bounds.min[2]
    out.add(`${i},${j},${k}`)
  }
  return out
}

describe('box helpers', () => {
  it('clampBox sorts and clamps to the volume', () => {
    const b = clampBox(box([5, -2, 9], [1, 3, 20]), [10, 10, 10])
    expect(b).toEqual({ min: [1, 0, 9], max: [5, 3, 9] })
  })

  it('extent and voxel count are inclusive', () => {
    const b = box([1, 2, 3], [3, 2, 5])
    expect(boxExtent(b)).toEqual([3, 1, 3])
    expect(boxVoxelCount(b)).toBe(9)
  })

  it('dilatedBox expands every side', () => {
    expect(dilatedBox(box([2, 2, 2], [3, 3, 3]), 2)).toEqual({ min: [0, 0, 0], max: [5, 5, 5] })
  })

  it('boxStats covers only the box', () => {
    const vol = makeVolume([4, 4, 4], (i) => (i < 2 ? 10 : 50))
    const s = boxStats(vol, box([0, 0, 0], [1, 3, 3]))
    expect(s).toMatchObject({ min: 10, max: 10, mean: 10 })
    const all = boxStats(vol, box([0, 0, 0], [3, 3, 3]))
    expect(all.min).toBe(10)
    expect(all.max).toBe(50)
    expect(all.mean).toBe(30)
    expect(all.count).toBe(64)
  })

  it('boxStats honors a constraint predicate', () => {
    const vol = makeVolume([4, 4, 4], (i) => i)
    const s = boxStats(vol, box([0, 0, 0], [3, 3, 3]), 0, (i) => i === 2)
    expect(s).toMatchObject({ min: 2, max: 2, mean: 2, count: 16 })
  })
})

describe('otsuThreshold', () => {
  it('separates a bimodal box, landing mid-gap', () => {
    const vol = makeVolume([8, 8, 8], (i) => (i < 4 ? 100 : 300))
    const t = otsuThreshold(vol, box([0, 0, 0], [7, 7, 7]))
    // The plateau midpoint puts the threshold near the middle of the empty
    // gap between the modes, not hugging the lower mode.
    expect(t).toBeGreaterThan(150)
    expect(t).toBeLessThan(250)
  })

  it('never returns below the fixed floor', () => {
    const vol = makeVolume([8, 8, 8], (i) => (i < 4 ? 10 : 60))
    expect(otsuThreshold(vol, box([0, 0, 0], [7, 7, 7]))).toBe(OTSU_FLOOR)
  })

  it('degenerate constant box falls back to the fixed default', () => {
    const vol = makeVolume([4, 4, 4], () => 7)
    expect(otsuThreshold(vol, box([0, 0, 0], [3, 3, 3]))).toBe(AUTO_THRESHOLD_FALLBACK)
  })
})

describe('boxHistogram', () => {
  it('bins every in-box voxel over the box range', () => {
    const vol = makeVolume([4, 1, 1], (i) => i * 10) // 0,10,20,30
    const h = boxHistogram(vol, box([0, 0, 0], [3, 0, 0]), 4)
    expect(h.min).toBe(0)
    expect(h.max).toBe(30)
    expect([...h.counts]).toEqual([1, 1, 1, 1])
  })

  it('honors the constraint and reports an empty box', () => {
    const vol = makeVolume([4, 1, 1], (i) => i)
    const h = boxHistogram(vol, box([0, 0, 0], [3, 0, 0]), 4, 0, () => false)
    expect(h.min).toBe(0)
    expect(h.max).toBe(0)
    expect([...h.counts]).toEqual([0, 0, 0, 0])
  })
})

describe('segmentRegion — threshold in box (high == low)', () => {
  const vol = makeVolume([6, 6, 6], (i, j, k) => i + j * 10 + k * 100)

  it('keeps voxels at/above the threshold, box-bounded', () => {
    const b = box([0, 0, 0], [5, 0, 0]) // values 0..5
    const res = segmentRegion(vol, b, b, params({ low: 3, high: 3 }))
    expect(selected(vol, res)).toEqual(new Set(['3,0,0', '4,0,0', '5,0,0']))
    expect(res.voxels).toBe(3)
    expect(res.truncated).toBe(false)
  })

  it('drops components below minVoxels', () => {
    // Bright singleton at (0,0,0) and a bright bar at x=3..5 on the same row.
    const v2 = makeVolume([6, 1, 1], (i) => (i === 0 || i >= 3 ? 100 : 0))
    const b = box([0, 0, 0], [5, 0, 0])
    const res = segmentRegion(v2, b, b, params({ low: 50, high: 50, minVoxels: 2 }))
    expect(selected(v2, res)).toEqual(new Set(['3,0,0', '4,0,0', '5,0,0']))
    expect(res.components).toBe(1)
  })

  it('26-connectivity bridges a diagonal that 6 does not', () => {
    const v2 = makeVolume([2, 2, 1], (i, j) => (i === j ? 100 : 0)) // (0,0) and (1,1)
    const b = box([0, 0, 0], [1, 1, 0])
    const six = segmentRegion(v2, b, b, params({ low: 50, high: 50, minVoxels: 2 }))
    expect(six.components).toBe(0) // two size-1 pieces, both dropped
    const twentySix = segmentRegion(
      v2,
      b,
      b,
      params({ low: 50, high: 50, minVoxels: 2, connectivity: 26 })
    )
    expect(twentySix.components).toBe(1)
    expect(twentySix.voxels).toBe(2)
  })

  it('honors a constraint predicate', () => {
    const b = box([0, 0, 0], [5, 0, 0])
    const res = segmentRegion(vol, b, b, params({ low: 0, high: 0 }), 0, (i) => i % 2 === 0)
    expect(selected(vol, res)).toEqual(new Set(['0,0,0', '2,0,0', '4,0,0']))
  })
})

describe('segmentRegion — grow from seed (hysteresis)', () => {
  // A bright core (100) with a dimmer rim (60) around it along x, in a dark
  // (0) volume: x=4..6 core, x=2..3 and 7..8 rim.
  const vol = makeVolume([12, 3, 3], (i, j, k) => {
    if (j !== 1 || k !== 1) return 0
    if (i >= 4 && i <= 6) return 100
    if (i >= 2 && i <= 8) return 60
    return 0
  })
  const seedBox = box([4, 1, 1], [6, 1, 1]) // entirely inside the core

  it('seeds at >= high inside the box and grows past it down to >= low', () => {
    const res = segmentRegion(vol, seedBox, wholeVolumeBox(vol.dims), params({ low: 50, high: 90 }))
    const got = selected(vol, res)
    expect(got.size).toBe(7) // x=2..8 on the center row
    for (let x = 2; x <= 8; x++) expect(got.has(`${x},1,1`)).toBe(true)
  })

  it('no seed at/above high -> empty result', () => {
    const res = segmentRegion(
      vol,
      box([2, 1, 1], [3, 1, 1]), // rim only, all 60 < high
      wholeVolumeBox(vol.dims),
      params({ low: 50, high: 90 })
    )
    expect(res.voxels).toBe(0)
  })

  it('grow bounds cap the reach (margin box)', () => {
    const bounds = clampBox(dilatedBox(seedBox, 1), vol.dims) // x=3..7 reachable
    const res = segmentRegion(vol, seedBox, bounds, params({ low: 50, high: 90 }))
    const got = selected(vol, res)
    expect(got.size).toBe(5)
    expect(got.has(`2,1,1`)).toBe(false)
    expect(got.has(`8,1,1`)).toBe(false)
  })

  it('NaN voxels never seed (grow) and are never kept (threshold)', () => {
    // NaN at x=1 amid 50s: no voxel reaches high=90, so a NaN "seed" would
    // wrongly flood the whole >= low row.
    const v2 = makeVolume([4, 1, 1], (i) => (i === 1 ? NaN : 50))
    const b = box([0, 0, 0], [3, 0, 0])
    const grow = segmentRegion(v2, b, wholeVolumeBox(v2.dims), params({ low: 40, high: 90 }))
    expect(grow.voxels).toBe(0)

    const thr = segmentRegion(v2, b, b, params({ low: 40, high: 40 }))
    expect(selected(v2, thr)).toEqual(new Set(['0,0,0', '2,0,0', '3,0,0']))
  })

  it('safety cap truncates a runaway grow and reports it', () => {
    const flat = makeVolume([10, 10, 10], () => 100)
    const b = box([5, 5, 5], [5, 5, 5])
    const res = segmentRegion(
      flat,
      b,
      wholeVolumeBox(flat.dims),
      params({ low: 50, high: 50, maxVoxels: 20 })
    )
    expect(res.truncated).toBe(true)
    expect(res.voxels).toBeGreaterThan(0)
    expect(res.voxels).toBeLessThan(1000)
  })
})

describe('segmentRegion — sparse path (bounds dwarf a finite cap)', () => {
  // Same core/rim layout as the grow tests: x=4..6 at 100, x=2..8 at 60.
  const vol = makeVolume([12, 3, 3], (i, j, k) => {
    if (j !== 1 || k !== 1) return 0
    if (i >= 4 && i <= 6) return 100
    if (i >= 2 && i <= 8) return 60
    return 0
  })
  const seedBox = box([4, 1, 1], [6, 1, 1])

  it('matches the dense result and returns tight bounds', () => {
    // 108-voxel bounds > 25 * 4 routes sparse; the dense run is the oracle.
    const dense = segmentRegion(
      vol,
      seedBox,
      wholeVolumeBox(vol.dims),
      params({ low: 50, high: 90 })
    )
    const sparse = segmentRegion(
      vol,
      seedBox,
      wholeVolumeBox(vol.dims),
      params({ low: 50, high: 90, maxVoxels: 25 })
    )
    expect(sparse.truncated).toBe(false)
    expect(sparse.voxels).toBe(dense.voxels)
    expect(selected(vol, sparse)).toEqual(selected(vol, dense))
    expect(sparse.bounds).toEqual({ min: [2, 1, 1], max: [8, 1, 1] })
  })

  it('no seed above high -> empty result with zero voxels', () => {
    const res = segmentRegion(
      vol,
      box([2, 1, 1], [3, 1, 1]), // rim only, all 60 < high
      wholeVolumeBox(vol.dims),
      params({ low: 50, high: 90, maxVoxels: 25 })
    )
    expect(res.voxels).toBe(0)
    expect(res.truncated).toBe(false)
  })

  it('caps a runaway flood (visited set grows past its initial capacity)', () => {
    const flat = makeVolume([24, 24, 24], () => 100) // 13824 > 3000 * 4
    const res = segmentRegion(
      flat,
      box([12, 12, 12], [12, 12, 12]),
      wholeVolumeBox(flat.dims),
      params({ low: 50, high: 50, maxVoxels: 3000 })
    )
    expect(res.truncated).toBe(true)
    expect(res.voxels).toBeGreaterThanOrEqual(3000)
    expect(res.voxels).toBeLessThan(13824)
  })
})

describe('constraintFromLabelMap', () => {
  it('allows only the chosen region', () => {
    const labelMap = new Uint16Array(4 * 4 * 4)
    labelMap[0] = 2
    labelMap[1] = 3
    const pred = constraintFromLabelMap(labelMap, [4, 4, 4], 2)
    expect(pred(0, 0, 0)).toBe(true)
    expect(pred(1, 0, 0)).toBe(false)
    expect(pred(2, 0, 0)).toBe(false)
  })
})

describe('constraintFromVolume', () => {
  it('samples the given frame, clamped to the volume frame count', () => {
    const base = makeVolume([2, 1, 1], () => 100)
    // Two frames on the same grid: frame 0 = [1, 1], frame 1 = [1, 0].
    const con = makeVolume([2, 1, 1], () => 1)
    Object.assign(con, { frames: 2, raw: new Float32Array([1, 1, 1, 0]) })

    const f0 = constraintFromVolume(base, con, 0)!
    expect(f0(1, 0, 0)).toBe(true)

    const f1 = constraintFromVolume(base, con, 1)!
    expect(f1(0, 0, 0)).toBe(true)
    expect(f1(1, 0, 0)).toBe(false)

    // Past the constraint's own frame count -> its last frame.
    const beyond = constraintFromVolume(base, con, 7)!
    expect(beyond(1, 0, 0)).toBe(false)
  })
})
