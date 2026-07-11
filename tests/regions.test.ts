import { describe, expect, it } from 'vitest'
import { dirOfPath } from '../src/renderer/src/segmentation/exportRegions'
import {
  applyMaskAsRegion,
  buildColorTable,
  computeRegionStats,
  defaultRegionColor,
  eraseRegion,
  extractModelPreviewRGBA,
  extractPreviewRGBA,
  extractRegionsRGBA,
  maskUnion,
  packColor,
  paintDisk,
  paintStroke,
  regionBoundingBox,
  remapForExport,
  restoreRegion,
  type Region
} from '../src/renderer/src/segmentation/regions'
import type { SegBox } from '../src/renderer/src/segmentation/segment'
import { PLANES } from '../src/renderer/src/slicing/extract'
import type { Volume } from '../src/renderer/src/volume/types'

const DIMS: [number, number, number] = [4, 4, 4]
const N = 64

function makeRegion(id: number, over: Partial<Region> = {}): Region {
  return {
    id,
    name: `Region ${id}`,
    color: defaultRegionColor(id),
    visible: true,
    voxelCount: 0,
    stats: null,
    ...over
  }
}

function makeVolume(value: (idx: number) => number): Volume {
  const raw = new Float32Array(N)
  for (let i = 0; i < N; i++) raw[i] = value(i)
  const affine = new Float64Array(16)
  affine[0] = affine[5] = affine[10] = affine[15] = 1
  return {
    name: 'synthetic',
    dims: DIMS,
    frames: 1,
    spacing: [1, 1, 1],
    datatypeCode: 16,
    datatypeName: 'float32',
    raw,
    slope: 1,
    inter: 0,
    affine,
    transformSource: 'spacing-fallback',
    suggestedRange: null,
    labels: null,
    stats: { dataMin: 0, dataMax: 0, p2: 0, p98: 0, typeRange: null }
  }
}

const stubImg = (w: number, h: number): ImageData =>
  ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) as unknown as ImageData

describe('colors', () => {
  it('default colors are valid hex and distinct for nearby ids', () => {
    expect(defaultRegionColor(1)).toMatch(/^#[0-9a-f]{6}$/)
    expect(defaultRegionColor(1)).not.toBe(defaultRegionColor(2))
  })

  it('packColor writes little-endian RGBA with full alpha', () => {
    expect(packColor('#ff0000') >>> 0).toBe(0xff0000ff)
    expect(packColor('#00ff00') >>> 0).toBe(0xff00ff00)
  })
})

describe('label-map edits', () => {
  const box: SegBox = { min: [1, 1, 1], max: [2, 2, 2] }

  it('applyMaskAsRegion writes only masked voxels', () => {
    const labelMap = new Uint16Array(N)
    const mask = new Uint8Array(8).fill(1)
    mask[7] = 0
    const written = applyMaskAsRegion(labelMap, DIMS, box, mask, 3)
    expect(written).toBe(7)
    expect(labelMap[1 + 4 + 16]).toBe(3) // box corner (1,1,1)
    expect(labelMap[2 + 8 + 32]).toBe(0) // masked-out corner (2,2,2)
    expect(labelMap[0]).toBe(0) // outside the box
  })

  it('erase + restore round-trips, without clobbering newer claims', () => {
    const labelMap = new Uint16Array(N)
    labelMap[5] = 2
    labelMap[9] = 2
    const indices = eraseRegion(labelMap, 2)
    expect([...indices]).toEqual([5, 9])
    expect(labelMap[5]).toBe(0)
    labelMap[9] = 7 // another region claims a voxel before undo
    restoreRegion(labelMap, indices, 2)
    expect(labelMap[5]).toBe(2)
    expect(labelMap[9]).toBe(7)
  })

  it('paintDisk stamps a disk and erase removes only its own id', () => {
    const labelMap = new Uint16Array(N)
    labelMap[0] = 9 // unrelated region at (0,0) of slice 0
    paintDisk(labelMap, DIMS, PLANES[0], 0, [1, 1], 1, 4, false)
    // 6-neighborhood disk of radius 1 on the plane: center + 4.
    expect(labelMap[1 + 4]).toBe(4)
    expect(labelMap[0 + 4]).toBe(4)
    expect(labelMap[1 + 0]).toBe(4)
    paintDisk(labelMap, DIMS, PLANES[0], 0, [1, 1], 5, 4, true)
    expect(labelMap[1 + 4]).toBe(0)
    expect(labelMap[0]).toBe(9) // other region untouched by erase
  })

  it('regionBoundingBox is tight and null for empty regions', () => {
    const labelMap = new Uint16Array(N)
    // Region 4 at (1,2,0) and (3,0,2).
    labelMap[1 + 2 * 4] = 4
    labelMap[3 + 2 * 16] = 4
    expect(regionBoundingBox(labelMap, DIMS, 4)).toEqual({ min: [1, 0, 0], max: [3, 2, 2] })
    expect(regionBoundingBox(labelMap, DIMS, 9)).toBeNull()
  })

  it('paintStroke leaves no gaps along the segment', () => {
    const labelMap = new Uint16Array(N)
    expect(paintStroke(labelMap, DIMS, PLANES[0], 0, [0, 0], [3, 0], 1, 1, false)).toBeGreaterThan(
      0
    )
    for (let i = 0; i < 4; i++) expect(labelMap[i]).toBe(1)
    expect(paintStroke(labelMap, DIMS, PLANES[0], 0, [0, 0], [3, 0], 1, 1, false)).toBe(0)
  })
})

describe('computeRegionStats', () => {
  it('counts and intensity stats per region', () => {
    const vol = makeVolume((i) => i)
    const labelMap = new Uint16Array(N)
    labelMap[10] = 1
    labelMap[20] = 1
    labelMap[30] = 2
    const [r1, r2] = computeRegionStats(vol, labelMap, [makeRegion(1), makeRegion(2)])
    expect(r1.voxelCount).toBe(2)
    expect(r1.stats).toEqual({ min: 10, max: 20, mean: 15 })
    expect(r2.voxelCount).toBe(1)
    expect(r2.stats).toEqual({ min: 30, max: 30, mean: 30 })
  })

  it('empty region gets null stats', () => {
    const vol = makeVolume(() => 0)
    const [r] = computeRegionStats(vol, new Uint16Array(N), [makeRegion(5)])
    expect(r.voxelCount).toBe(0)
    expect(r.stats).toBeNull()
  })

  it('NaN voxels count toward size but not toward the mean', () => {
    const vol = makeVolume((idx) => (idx === 20 ? NaN : 10))
    const labelMap = new Uint16Array(N)
    labelMap[10] = 1
    labelMap[20] = 1
    const [r] = computeRegionStats(vol, labelMap, [makeRegion(1)])
    expect(r.voxelCount).toBe(2)
    expect(r.stats).toEqual({ min: 10, max: 10, mean: 10 })
  })

  it('all-NaN region keeps its size with null stats', () => {
    const vol = makeVolume(() => NaN)
    const labelMap = new Uint16Array(N)
    labelMap[3] = 1
    const [r] = computeRegionStats(vol, labelMap, [makeRegion(1)])
    expect(r.voxelCount).toBe(1)
    expect(r.stats).toBeNull()
  })
})

describe('export helpers', () => {
  it('remapForExport assigns sequential values in list order', () => {
    const labelMap = new Uint16Array(N)
    labelMap[0] = 7
    labelMap[1] = 3
    const regions = [makeRegion(7), makeRegion(3)]
    const { data, entries } = remapForExport(labelMap, regions)
    expect(entries.map((e) => [e.value, e.region.id])).toEqual([
      [1, 7],
      [2, 3]
    ])
    expect(data[0]).toBe(1)
    expect(data[1]).toBe(2)
    expect(data[2]).toBe(0)
  })

  it('maskUnion covers exactly the given regions', () => {
    const labelMap = new Uint16Array(N)
    labelMap[0] = 1
    labelMap[1] = 2
    labelMap[2] = 3
    const out = maskUnion(labelMap, [makeRegion(1), makeRegion(3)])
    expect([...out.slice(0, 4)]).toEqual([1, 0, 1, 0])
  })

  it('maskUnion with no regions is all zeros (empty visible mask export)', () => {
    const labelMap = new Uint16Array(N)
    labelMap[0] = 1
    const out = maskUnion(labelMap, [])
    expect(out.every((v) => v === 0)).toBe(true)
  })

  it('buildColorTable emits one TSV row per region', () => {
    const table = buildColorTable([
      { value: 1, region: makeRegion(9, { name: 'left part', color: '#ff8000' }) }
    ])
    expect(table).toBe('0\t0\t0\t0\t0\t@table-escaped-v1@\n1\t255\t128\t0\t255\tleft part\n')
  })

  it('dirOfPath keeps the separator for filesystem roots', () => {
    expect(dirOfPath('/data/scans/a.nii')).toBe('/data/scans')
    expect(dirOfPath('C:\\scans\\a.nii')).toBe('C:\\scans')
    expect(dirOfPath('/a.nii')).toBe('/')
    expect(dirOfPath('C:\\a.nii')).toBe('C:\\')
    expect(dirOfPath('\\\\server\\share\\a.nii')).toBe('\\\\server\\share')
    expect(dirOfPath('a.nii')).toBe('')
  })
})

describe('slice extraction', () => {
  it('extractRegionsRGBA paints visible ids bottom-up', () => {
    const labelMap = new Uint16Array(N)
    labelMap[0] = 1 // voxel (0,0,0)
    const colorOf = new Uint32Array(2)
    colorOf[1] = packColor('#ffffff')
    const img = stubImg(4, 4)
    extractRegionsRGBA(labelMap, DIMS, PLANES[0], 0, colorOf, img)
    const px = new Uint32Array(img.data.buffer)
    // Row 0 is written to the bottom image row.
    expect(px[3 * 4 + 0] >>> 0).toBe(packColor('#ffffff') >>> 0)
    expect(px[0]).toBe(0)
  })

  it('extractPreviewRGBA maps box-local mask to slice coordinates', () => {
    const box: SegBox = { min: [1, 1, 0], max: [2, 2, 1] }
    const mask = new Uint8Array(2 * 2 * 2)
    mask[0] = 1 // box-local (0,0,0) = volume (1,1,0)
    const img = stubImg(4, 4)
    const color = packColor('#00ff00')
    extractPreviewRGBA(mask, box, DIMS, PLANES[0], 0, color, img)
    const px = new Uint32Array(img.data.buffer)
    expect(px[(4 - 1 - 1) * 4 + 1] >>> 0).toBe(color >>> 0)
    // A slice outside the box clears the buffer.
    px.fill(0xdeadbeef)
    extractPreviewRGBA(mask, box, DIMS, PLANES[0], 3, color, img)
    expect(px.every((v) => v === 0)).toBe(true)
  })

  it('extracts region and preview pixels through reversed screen directions', () => {
    const plane = { ...PLANES[0], colDirection: -1 as const, rowDirection: -1 as const }
    const labelMap = new Uint16Array(N)
    labelMap[1 + 2 * 4] = 1
    const colorOf = new Uint32Array([0, packColor('#ffffff')])
    const regionImage = stubImg(4, 4)
    extractRegionsRGBA(labelMap, DIMS, plane, 0, colorOf, regionImage)
    expect(new Uint32Array(regionImage.data.buffer)[2 * 4 + 2] >>> 0).toBe(colorOf[1] >>> 0)

    const box: SegBox = { min: [1, 2, 0], max: [1, 2, 0] }
    const previewImage = stubImg(4, 4)
    extractPreviewRGBA(new Uint8Array([1]), box, DIMS, plane, 0, colorOf[1], previewImage)
    expect(new Uint32Array(previewImage.data.buffer)[2 * 4 + 2] >>> 0).toBe(colorOf[1] >>> 0)
  })

  it('extracts both whole-grid preview classes with their own colors', () => {
    const labels = new Uint8Array(N)
    labels[0] = 1
    labels[1] = 2
    const image = stubImg(4, 4)
    const colors = new Uint32Array([0, packColor('#ffffff'), packColor('#cd3e4e')])
    extractModelPreviewRGBA(labels, DIMS, PLANES[0], 0, colors, image)
    const pixels = new Uint32Array(image.data.buffer)
    expect(Array.from(pixels).filter((pixel) => pixel === colors[1])).toHaveLength(1)
    expect(Array.from(pixels).filter((pixel) => pixel === colors[2])).toHaveLength(1)
  })
})
