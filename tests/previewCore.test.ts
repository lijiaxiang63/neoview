import { describe, expect, it } from 'vitest'
import {
  applyMessage,
  computeInCache,
  emptyCache,
  type ComputeRequest
} from '../src/renderer/src/segmentation/previewCore'
import {
  boxExtent,
  segmentRegion,
  wholeVolumeBox,
  type AlignedGridSource,
  type SegBox
} from '../src/renderer/src/segmentation/segment'

function identity(): Float64Array {
  const m = new Float64Array(16)
  m[0] = m[5] = m[10] = m[15] = 1
  return m
}

function makeGrid(
  dims: [number, number, number],
  value: (i: number, j: number, k: number) => number
): AlignedGridSource {
  const [nx, ny, nz] = dims
  const raw = new Float32Array(nx * ny * nz)
  let idx = 0
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, idx++) raw[idx] = value(i, j, k)
    }
  }
  return { dims, raw, slope: 1, inter: 0, affine: identity(), frames: 1 }
}

const box = (min: [number, number, number], max: [number, number, number]): SegBox => ({ min, max })

/** Voxels selected by a result, as global "i,j,k" strings. */
function selected(res: { mask: Uint8Array; bounds: SegBox }): Set<string> {
  const out = new Set<string>()
  const [bw, bh] = boxExtent(res.bounds)
  for (let p = 0; p < res.mask.length; p++) {
    if (res.mask[p] === 0) continue
    const li = p % bw
    const lj = Math.floor(p / bw) % bh
    const lk = Math.floor(p / (bw * bh))
    out.add(`${res.bounds.min[0] + li},${res.bounds.min[1] + lj},${res.bounds.min[2] + lk}`)
  }
  return out
}

const request = (over: Partial<ComputeRequest> = {}): ComputeRequest => ({
  token: 1,
  box: box([0, 0, 0], [3, 3, 3]),
  bounds: box([0, 0, 0], [3, 3, 3]),
  params: { low: 5, high: 5, connectivity: 6, minVoxels: 1, maxVoxels: Infinity },
  frameOffset: 0,
  frame: 0,
  constraint: { type: 'none' },
  ...over
})

describe('previewCore', () => {
  const dims: [number, number, number] = [4, 4, 4]
  // A single bright voxel at the origin, dim everywhere else.
  const grid = makeGrid(dims, (i, j, k) => (i === 0 && j === 0 && k === 0 ? 10 : 0))

  it('returns null before any volume is cached', () => {
    const cache = emptyCache()
    expect(computeInCache(cache, request())).toBeNull()
  })

  it('matches a direct segmentRegion call once the volume is cached', () => {
    const cache = emptyCache()
    applyMessage(cache, { type: 'volume', grid })
    const req = request()
    const viaCache = computeInCache(cache, req)
    const direct = segmentRegion(grid, req.box, req.bounds, req.params, req.frameOffset, null)
    expect(viaCache).not.toBeNull()
    expect(selected(viaCache!)).toEqual(selected(direct))
    expect(viaCache!.voxels).toBe(1)
  })

  it('a new volume clears the previously cached overlays and label map', () => {
    const cache = emptyCache()
    applyMessage(cache, { type: 'volume', grid })
    applyMessage(cache, { type: 'overlay', id: 7, grid })
    applyMessage(cache, { type: 'labelMap', data: new Uint16Array(dims[0] * dims[1] * dims[2]) })
    applyMessage(cache, { type: 'volume', grid })
    expect(cache.overlays.size).toBe(0)
    expect(cache.labelMap).toBeNull()
  })

  it('dropOverlay releases one cached overlay and leaves the rest intact', () => {
    const cache = emptyCache()
    applyMessage(cache, { type: 'volume', grid })
    applyMessage(cache, { type: 'overlay', id: 7, grid })
    applyMessage(cache, { type: 'overlay', id: 8, grid })
    applyMessage(cache, { type: 'dropOverlay', id: 7 })
    expect([...cache.overlays.keys()]).toEqual([8])
    // A compute against the dropped overlay now misses (sync fallback);
    // the surviving one still works.
    expect(
      computeInCache(cache, request({ constraint: { type: 'overlay', overlayId: 7 } }))
    ).toBeNull()
    expect(
      computeInCache(cache, request({ constraint: { type: 'overlay', overlayId: 8 } }))
    ).not.toBeNull()
  })

  it('returns null when a constraint refers to data the cache is missing', () => {
    const cache = emptyCache()
    applyMessage(cache, { type: 'volume', grid })
    expect(
      computeInCache(cache, request({ constraint: { type: 'overlay', overlayId: 7 } }))
    ).toBeNull()
    expect(
      computeInCache(cache, request({ constraint: { type: 'region', regionId: 1 } }))
    ).toBeNull()
  })

  it('applies a cached region constraint to bound the flood', () => {
    const cache = emptyCache()
    // A bright 2x2x2 block; the label map marks region 1 over a single voxel.
    const bright = makeGrid(dims, (i, j, k) => (i < 2 && j < 2 && k < 2 ? 10 : 0))
    const labelMap = new Uint16Array(dims[0] * dims[1] * dims[2])
    labelMap[0] = 1 // voxel (0,0,0) belongs to region 1
    applyMessage(cache, { type: 'volume', grid: bright })
    applyMessage(cache, { type: 'labelMap', data: labelMap })
    const req = request({
      box: box([0, 0, 0], [0, 0, 0]),
      bounds: wholeVolumeBox(dims),
      constraint: { type: 'region', regionId: 1 }
    })
    const res = computeInCache(cache, req)
    expect(res).not.toBeNull()
    // The region constraint confines the flood to voxel (0,0,0) alone.
    expect(selected(res!)).toEqual(new Set(['0,0,0']))
  })
})
