import { describe, expect, it } from 'vitest'
// @ts-expect-error plain mjs helper shared with the fixture generator
import { buildVolume } from '../scripts/make-test-volumes.mjs'
import { parseVolume } from '../src/renderer/src/volume/parse'
import type { Volume } from '../src/renderer/src/volume/types'
import { PLANES } from '../src/renderer/src/slicing/extract'
import {
  MASK_COLOR,
  MAX_LISTED_LABELS,
  buildMapLUT,
  defaultLayerSettings,
  extractOverlayRGBA,
  guessOverlayKind,
  labelColor,
  labelColorCSS,
  labelInventory,
  listLabelIds,
  overlayVoxelToBase,
  sampleOverlayAt,
  voxelMapFor,
  type OverlayLayer
} from '../src/renderer/src/slicing/overlay'

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkVol(opts: any): Volume {
  return parseVolume('t.nii', toArrayBuffer(buildVolume(opts)))
}

function mkLayer(volume: Volume, overrides: Partial<OverlayLayer> = {}): OverlayLayer {
  return {
    id: 1,
    volume,
    kind: 'mask',
    visible: true,
    opacity: 1,
    range: { lo: 0, hi: 1 },
    colormap: 'warm',
    hiddenLabels: new Set<number>(),
    ...overrides
  }
}

const stub = (w: number, h: number): ImageData =>
  ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) as unknown as ImageData

/** Packed pixel at slice coords (c, r), accounting for bottom-up row order. */
function pixelAt(img: ImageData, c: number, r: number): number {
  const px = new Uint32Array(img.data.buffer)
  return px[(img.height - 1 - r) * img.width + c]
}

function alphaAt(img: ImageData, c: number, r: number): number {
  return (pixelAt(img, c, r) >>> 24) & 0xff
}

const identity = {
  rows: [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0]
  ]
}

describe('extractOverlayRGBA — grid alignment', () => {
  it('same-grid labels hit exactly one pixel on all three planes', () => {
    const value = (i: number, j: number, k: number): number =>
      i === 2 && j === 3 && k === 1 ? 7 : 0
    const base = mkVol({ dims: [8, 6, 4], dtype: 'uint8', value: () => 9, rowTransform: identity })
    const overlay = mkVol({ dims: [8, 6, 4], dtype: 'uint8', value, rowTransform: identity })
    const layer = mkLayer(overlay, { kind: 'labels' })

    // Plane XY: slice k=1, expect pixel (c=i=2, r=j=3).
    const xy = stub(8, 6)
    extractOverlayRGBA(layer, base, PLANES[0], 1, 0, xy)
    expect(pixelAt(xy, 2, 3)).toBe(labelColor(7))
    let opaque = 0
    for (const a of new Uint32Array(xy.data.buffer)) if (a >>> 24) opaque++
    expect(opaque).toBe(1)

    // Plane XZ: slice j=3, expect (c=i=2, r=k=1).
    const xz = stub(8, 4)
    extractOverlayRGBA(layer, base, PLANES[1], 3, 0, xz)
    expect(pixelAt(xz, 2, 1)).toBe(labelColor(7))

    // Plane YZ: slice i=2, expect (c=j=3, r=k=1).
    const yz = stub(6, 4)
    extractOverlayRGBA(layer, base, PLANES[2], 2, 0, yz)
    expect(pixelAt(yz, 3, 1)).toBe(labelColor(7))
  })

  it('follows both in-plane screen directions', () => {
    const value = (i: number, j: number): number => (i === 2 && j === 3 ? 7 : 0)
    const base = mkVol({ dims: [8, 6, 1], dtype: 'uint8', value: () => 9, rowTransform: identity })
    const overlay = mkVol({ dims: [8, 6, 1], dtype: 'uint8', value, rowTransform: identity })
    const img = stub(8, 6)
    extractOverlayRGBA(
      mkLayer(overlay, { kind: 'labels' }),
      base,
      { ...PLANES[0], colDirection: -1, rowDirection: -1 },
      0,
      0,
      img
    )
    const pixels = new Uint32Array(img.data.buffer)
    expect(pixels[3 * 8 + (8 - 1 - 2)]).toBe(labelColor(7))
    expect(pixels.filter((pixel) => pixel >>> 24)).toHaveLength(1)
  })

  it('2x-coarse overlay covers the nearest-neighbor pixel set', () => {
    const base = mkVol({ dims: [8, 8, 4], dtype: 'uint8', value: () => 0, rowTransform: identity })
    const overlay = mkVol({
      dims: [4, 4, 2],
      dtype: 'uint8',
      value: (i: number, j: number, k: number) => (i === 1 && j === 1 && k === 1 ? 1 : 0),
      spacing: [2, 2, 2],
      rowTransform: {
        rows: [
          [2, 0, 0, 0],
          [0, 2, 0, 0],
          [0, 0, 2, 0]
        ]
      }
    })
    const layer = mkLayer(overlay, { kind: 'mask' })
    // Base slice k=2 maps to overlay z=1 exactly. round(i/2)===1 → i ∈ {1, 2}.
    const img = stub(8, 8)
    extractOverlayRGBA(layer, base, PLANES[0], 2, 0, img)
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const hit = Math.round(c / 2) === 1 && Math.round(r / 2) === 1
        expect(pixelAt(img, c, r)).toBe(hit ? MASK_COLOR : 0)
      }
    }
  })

  it('base pixels mapping outside the overlay are transparent', () => {
    const base = mkVol({ dims: [6, 6, 2], dtype: 'uint8', value: () => 1, rowTransform: identity })
    const overlay = mkVol({
      dims: [6, 6, 2],
      dtype: 'uint8',
      value: () => 1,
      rowTransform: {
        rows: [
          [1, 0, 0, 10], // shifted +10 along world axis 0: base i maps to i-10 < 0
          [0, 1, 0, 0],
          [0, 0, 1, 0]
        ]
      }
    })
    const img = stub(6, 6)
    extractOverlayRGBA(mkLayer(overlay), base, PLANES[0], 0, 0, img)
    for (const p of new Uint32Array(img.data.buffer)) expect(p).toBe(0)
  })

  it('clamps the shared frame index to the overlay frame count', () => {
    const base = mkVol({ dims: [4, 4, 2], dtype: 'uint8', value: () => 1, rowTransform: identity })
    const overlay = mkVol({
      dims: [4, 4, 2, 2],
      dtype: 'uint8',
      value: (i: number, j: number, k: number, t: number) =>
        t === 1 && i === 0 && j === 0 ? 3 : 0,
      rowTransform: identity
    })
    const layer = mkLayer(overlay, { kind: 'labels' })
    const img = stub(4, 4)
    extractOverlayRGBA(layer, base, PLANES[0], 0, 5, img) // frame 5 → clamps to 1
    expect(pixelAt(img, 0, 0)).toBe(labelColor(3))
    expect(sampleOverlayAt(layer, base, [0, 0, 0], 5)).toBe(3)
  })
})

describe('extractOverlayRGBA — map windows', () => {
  it('sequential: below lo transparent, lo at index 0, clamps above hi', () => {
    const base = mkVol({
      dims: [8, 2, 2],
      dtype: 'float32',
      value: (i: number) => i * 50, // 0, 50, 100, ..., 350
      rowTransform: identity
    })
    const layer = mkLayer(base, { kind: 'map', colormap: 'warm', range: { lo: 100, hi: 200 } })
    const img = stub(8, 2)
    extractOverlayRGBA(layer, base, PLANES[0], 0, 0, img)
    const lut = buildMapLUT('warm')
    expect(alphaAt(img, 0, 0)).toBe(0) // 0 < lo
    expect(alphaAt(img, 1, 0)).toBe(0) // 50 < lo
    expect(pixelAt(img, 2, 0)).toBe(lut.pos[0]) // exactly lo
    expect(pixelAt(img, 7, 0)).toBe(lut.pos[255]) // 350 clamps past hi
  })

  it('signed: magnitude window with separate arms per sign', () => {
    const base = mkVol({
      dims: [8, 2, 2],
      dtype: 'float32',
      value: (i: number) => (i - 4) * 50, // -200 .. 150
      rowTransform: identity
    })
    const layer = mkLayer(base, { kind: 'map', colormap: 'signed', range: { lo: 100, hi: 200 } })
    const img = stub(8, 2)
    extractOverlayRGBA(layer, base, PLANES[0], 0, 0, img)
    const lut = buildMapLUT('signed')
    expect(alphaAt(img, 3, 0)).toBe(0) // -50, |v| < lo
    expect(alphaAt(img, 5, 0)).toBe(0) // +50, |v| < lo
    expect(pixelAt(img, 2, 0)).toBe(lut.neg![0]) // -100 → negative arm
    expect(pixelAt(img, 7, 0)).toBe(lut.pos[Math.floor(((150 - 100) * 255) / 100)]) // +150
    expect(lut.neg![0]).not.toBe(lut.pos[0])
  })

  it('NaN voxels are transparent', () => {
    const base = mkVol({
      dims: [2, 2, 2],
      dtype: 'float32',
      value: (i: number) => (i === 0 ? NaN : 500),
      rowTransform: identity
    })
    const layer = mkLayer(base, { kind: 'map', colormap: 'warm', range: { lo: 0, hi: 100 } })
    const img = stub(2, 2)
    extractOverlayRGBA(layer, base, PLANES[0], 0, 0, img)
    expect(alphaAt(img, 0, 0)).toBe(0)
    expect(alphaAt(img, 1, 0)).toBe(255)
  })
})

describe('extractOverlayRGBA — mask scaling', () => {
  it('shows nonzero scaled values only', () => {
    const base = mkVol({
      dims: [4, 2, 2],
      dtype: 'uint8',
      value: (i: number) => (i < 2 ? 0 : 3),
      rowTransform: identity
    })
    const img = stub(4, 2)
    extractOverlayRGBA(mkLayer(base, { kind: 'mask' }), base, PLANES[0], 0, 0, img)
    expect(pixelAt(img, 0, 0)).toBe(0)
    expect(pixelAt(img, 3, 0)).toBe(MASK_COLOR)
  })

  it('treats scaled zero as empty (slope 2, inter -2, raw 1)', () => {
    const base = mkVol({
      dims: [4, 2, 2],
      dtype: 'int16',
      value: (i: number) => i, // scaled: -2, 0, 2, 4
      slope: 2,
      inter: -2,
      rowTransform: identity
    })
    const img = stub(4, 2)
    extractOverlayRGBA(mkLayer(base, { kind: 'mask' }), base, PLANES[0], 0, 0, img)
    expect(pixelAt(img, 0, 0)).toBe(MASK_COLOR) // scaled -2 is nonzero
    expect(pixelAt(img, 1, 0)).toBe(0) // raw 1 → scaled 0
    expect(pixelAt(img, 2, 0)).toBe(MASK_COLOR)
  })

  it.each(['mask', 'labels'] as const)('keeps non-finite %s values transparent', (kind) => {
    const base = mkVol({
      dims: [2, 2, 2],
      dtype: 'float32',
      value: () => 1,
      rowTransform: identity
    })
    base.raw[0] = Number.NaN
    base.raw[1] = Number.POSITIVE_INFINITY
    const img = stub(2, 2)

    extractOverlayRGBA(mkLayer(base, { kind }), base, PLANES[0], 0, 0, img)

    expect(alphaAt(img, 0, 0)).toBe(0)
    expect(alphaAt(img, 1, 0)).toBe(0)
  })
})

describe('label palette', () => {
  it('is deterministic, opaque, and pairwise distinct for ids 1..20', () => {
    expect(labelColor(5)).toBe(labelColor(5))
    const seen = new Set<number>()
    for (let id = 1; id <= 20; id++) {
      const c = labelColor(id)
      expect((c >>> 24) & 0xff).toBe(255)
      seen.add(c)
    }
    expect(seen.size).toBe(20)
  })

  it('labelColorCSS mirrors the packed channels', () => {
    const c = labelColor(9)
    expect(labelColorCSS(9)).toBe(`rgb(${c & 0xff}, ${(c >>> 8) & 0xff}, ${(c >>> 16) & 0xff})`)
  })
})

describe('hidden labels', () => {
  it('suppresses only the hidden ids', () => {
    const vol = mkVol({
      dims: [4, 2, 2],
      dtype: 'uint8',
      value: (i: number) => i, // ids 0..3 along axis 0
      rowTransform: identity
    })
    const layer = mkLayer(vol, { kind: 'labels', hiddenLabels: new Set([2]) })
    const img = stub(4, 2)
    extractOverlayRGBA(layer, vol, PLANES[0], 0, 0, img)
    expect(alphaAt(img, 0, 0)).toBe(0) // id 0: always transparent
    expect(pixelAt(img, 1, 0)).toBe(labelColor(1))
    expect(alphaAt(img, 2, 0)).toBe(0) // hidden
    expect(pixelAt(img, 3, 0)).toBe(labelColor(3))
  })
})

describe('labelInventory', () => {
  it('counts voxels and picks a representative inside a solid block', () => {
    const vol = mkVol({
      dims: [8, 8, 4],
      dtype: 'uint8',
      value: (i: number, j: number, k: number) => (i >= 1 && i <= 2 && j === 1 && k === 1 ? 2 : 0)
    })
    const [entry] = labelInventory(vol)
    expect(entry.id).toBe(2)
    expect(entry.count).toBe(2)
    expect(entry.pos![1]).toBe(1)
    expect(entry.pos![2]).toBe(1)
    expect([1, 2]).toContain(entry.pos![0])
    expect(labelInventory(vol)).toBe(labelInventory(vol)) // memoized
  })

  it('keeps the representative on the label for split shapes', () => {
    // Two far-apart voxels: the centroid falls between them on empty space.
    const vol = mkVol({
      dims: [8, 2, 2],
      dtype: 'uint8',
      value: (i: number, j: number, k: number) =>
        (i === 0 || i === 6) && j === 0 && k === 0 ? 4 : 0
    })
    const [entry] = labelInventory(vol)
    expect(entry.count).toBe(2)
    expect([0, 6]).toContain(entry.pos![0])
  })

  it('includes zero-count table entries with a null position', () => {
    const vol = mkVol({
      dims: [4, 2, 2],
      dtype: 'uint8',
      value: (i: number) => (i === 0 ? 3 : 0),
      labels: [
        [3, 'region-a'],
        [9, 'region-x'] // named but absent from the data
      ]
    })
    const entries = labelInventory(vol)
    expect(entries.map((e) => e.id)).toEqual([3, 9])
    expect(entries[0].count).toBe(4) // one voxel per (j,k) combination
    expect(entries[1].count).toBe(0)
    expect(entries[1].pos).toBeNull()
  })

  it('listLabelIds derives from the inventory', () => {
    const vol = mkVol({
      dims: [8, 2, 2],
      dtype: 'int16',
      value: (i: number) => (i % 2 === 0 ? 0 : 5 * i) // 5, 15, 25, 35
    })
    expect(listLabelIds(vol)).toEqual([5, 15, 25, 35])
    expect(listLabelIds(vol).length).toBeLessThanOrEqual(MAX_LISTED_LABELS)
  })
})

describe('overlayVoxelToBase', () => {
  it('maps a coarse offset overlay voxel into base coordinates', () => {
    const base = mkVol({ dims: [8, 8, 8], dtype: 'uint8', value: () => 0, rowTransform: identity })
    const overlay = mkVol({
      dims: [4, 4, 4],
      dtype: 'uint8',
      value: () => 0,
      rowTransform: {
        rows: [
          [2, 0, 0, 1],
          [0, 2, 0, 0],
          [0, 0, 2, 0]
        ]
      }
    })
    // Overlay voxel (1,1,1) sits at world (3,2,2) = base voxel (3,2,2).
    expect(overlayVoxelToBase(base, overlay, [1, 1, 1])).toEqual([3, 2, 2])
  })
})

describe('guessOverlayKind', () => {
  const dims = [4, 4, 2]
  it('binary integer volume → mask', () => {
    expect(
      guessOverlayKind(mkVol({ dims, dtype: 'uint8', value: (i: number) => (i === 0 ? 1 : 0) }))
    ).toBe('mask')
  })
  it('small non-negative integer range → labels', () => {
    expect(guessOverlayKind(mkVol({ dims, dtype: 'int16', value: (i: number) => i * 10 }))).toBe(
      'labels'
    )
  })
  it('float volume → map', () => {
    expect(guessOverlayKind(mkVol({ dims, dtype: 'float32', value: (i: number) => i }))).toBe('map')
  })
  it('scaled integers → map', () => {
    expect(
      guessOverlayKind(mkVol({ dims, dtype: 'int16', value: (i: number) => i, slope: 0.5 }))
    ).toBe('map')
  })
  it('wide integer range → map', () => {
    expect(guessOverlayKind(mkVol({ dims, dtype: 'int16', value: (i: number) => i * 1500 }))).toBe(
      'map'
    )
  })
  it('an embedded name table settles it regardless of stats', () => {
    const vol = mkVol({
      dims,
      dtype: 'int16',
      value: (i: number) => i * 1500, // wide range would otherwise say map
      labels: [[1, 'region-a']]
    })
    expect(vol.labels?.get(1)).toBe('region-a')
    expect(guessOverlayKind(vol)).toBe('labels')
  })
})

describe('defaultLayerSettings', () => {
  it('negative data → signed colormap with magnitude window', () => {
    const vol = mkVol({
      dims: [8, 2, 2],
      dtype: 'float32',
      value: (i: number) => (i - 4) * 100 // -400 .. 300
    })
    const s = defaultLayerSettings(vol)
    expect(s.colormap).toBe('signed')
    expect(s.range).toEqual({ lo: 0, hi: 400 })
  })
  it('non-negative data → warm with percentile window', () => {
    const vol = mkVol({ dims: [8, 8, 8], dtype: 'float32', value: (i: number) => i * 10 })
    const s = defaultLayerSettings(vol)
    expect(s.colormap).toBe('warm')
    expect(s.range.lo).toBe(vol.stats.p2)
    expect(s.range.hi).toBe(vol.stats.p98)
  })
})

describe('sampleOverlayAt / voxelMapFor', () => {
  it('reads the scaled value at an aligned coordinate', () => {
    const base = mkVol({ dims: [4, 4, 2], dtype: 'uint8', value: () => 0, rowTransform: identity })
    const overlay = mkVol({
      dims: [4, 4, 2],
      dtype: 'int16',
      value: (i: number, j: number) => i + 10 * j,
      slope: 2,
      rowTransform: identity
    })
    const layer = mkLayer(overlay)
    expect(sampleOverlayAt(layer, base, [3, 2, 1], 0)).toBe(46)
    expect(sampleOverlayAt(layer, base, [3, 2, 5], 0)).toBeNull() // out of bounds
    // Cache returns a stable mapping for the same (base, overlay) pair.
    expect(voxelMapFor(base, overlay)).toBe(voxelMapFor(base, overlay))
  })

  it('does not report non-finite values that render transparently', () => {
    const base = mkVol({
      dims: [2, 2, 2],
      dtype: 'float32',
      value: () => 1,
      rowTransform: identity
    })
    base.raw[0] = Number.NaN
    base.raw[1] = Number.POSITIVE_INFINITY
    const layer = mkLayer(base, { kind: 'labels' })

    expect(sampleOverlayAt(layer, base, [0, 0, 0], 0)).toBeNull()
    expect(sampleOverlayAt(layer, base, [1, 0, 0], 0)).toBeNull()
  })
})
