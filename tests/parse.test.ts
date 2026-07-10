import { describe, expect, it } from 'vitest'
// @ts-expect-error plain mjs helper shared with the fixture generator
import { buildVolume } from '../scripts/make-test-volumes.mjs'
import { parseLabelTable, parseVolume } from '../src/renderer/src/volume/parse'
import { ParseError } from '../src/renderer/src/volume/types'
import { extractSliceToImageData, PLANES } from '../src/renderer/src/slicing/extract'

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

const ramp = (i: number): number => (i * 4) % 256

describe('parseVolume', () => {
  it('parses a little-endian uint8 volume', () => {
    const buf = buildVolume({ dims: [8, 6, 4], dtype: 'uint8', value: ramp })
    const vol = parseVolume('t.nii', toArrayBuffer(buf))
    expect(vol.dims).toEqual([8, 6, 4])
    expect(vol.frames).toBe(1)
    expect(vol.datatypeName).toBe('uint8')
    expect(vol.raw[5]).toBe(20)
    expect(vol.transformSource).toBe('spacing-fallback')
  })

  it('parses big-endian int16 identically to little-endian', () => {
    const mk = (littleEndian: boolean): ReturnType<typeof parseVolume> =>
      parseVolume(
        't.nii',
        toArrayBuffer(
          buildVolume({
            dims: [8, 6, 4],
            dtype: 'int16',
            littleEndian,
            value: (i) => i * 100 - 300
          })
        )
      )
    const le = mk(true)
    const be = mk(false)
    expect(Array.from(be.raw)).toEqual(Array.from(le.raw))
    expect(be.raw[7]).toBe(400)
  })

  it('applies slope/inter defaults (slope 0 -> 1)', () => {
    const buf = buildVolume({
      dims: [4, 4, 4],
      dtype: 'int16',
      value: () => 10,
      slope: 0,
      inter: 0
    })
    const vol = parseVolume('t.nii', toArrayBuffer(buf))
    expect(vol.slope).toBe(1)
    expect(vol.inter).toBe(0)
  })

  it('keeps explicit slope/inter', () => {
    const buf = buildVolume({
      dims: [4, 4, 4],
      dtype: 'int16',
      value: () => 2000,
      slope: 0.5,
      inter: -25
    })
    const vol = parseVolume('t.nii', toArrayBuffer(buf))
    expect(vol.raw[0] * vol.slope + vol.inter).toBe(975)
  })

  it('parses 4D volumes', () => {
    const buf = buildVolume({
      dims: [4, 4, 4, 3],
      dtype: 'float32',
      value: (_i, _j, k, t) => k + 100 * t
    })
    const vol = parseVolume('t.nii', toArrayBuffer(buf))
    expect(vol.frames).toBe(3)
    const frameStride = 4 * 4 * 4
    expect(vol.raw[2 * frameStride]).toBe(200)
  })

  it('rejects truncated data', () => {
    const buf = buildVolume({ dims: [8, 8, 8], dtype: 'uint8', value: () => 0 })
    const cut = toArrayBuffer(buf).slice(0, 352 + 100)
    expect(() => parseVolume('t.nii', cut)).toThrowError(ParseError)
    try {
      parseVolume('t.nii', cut)
    } catch (e) {
      expect((e as ParseError).code).toBe('truncated')
    }
  })

  it('rejects a non-finite data offset', () => {
    const buf = buildVolume({ dims: [4, 4, 4], dtype: 'uint8', value: () => 0 })
    new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setFloat32(108, Number.NaN, true)

    expect(() => parseVolume('t.nii', toArrayBuffer(buf))).toThrowError(ParseError)
    try {
      parseVolume('t.nii', toArrayBuffer(buf))
    } catch (error) {
      expect((error as ParseError).code).toBe('bad-offset')
    }
  })

  it('sanitizes non-finite voxel spacing to finite positive geometry', () => {
    const buf = buildVolume({ dims: [4, 4, 4], dtype: 'uint8', value: () => 0 })
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    view.setFloat32(80, Number.POSITIVE_INFINITY, true)
    view.setFloat32(84, Number.NEGATIVE_INFINITY, true)

    const volume = parseVolume('t.nii', toArrayBuffer(buf))

    expect(volume.spacing.every((value) => Number.isFinite(value) && value > 0)).toBe(true)
  })

  it('rejects a broken signature', () => {
    const buf = buildVolume({ dims: [4, 4, 4], dtype: 'uint8', value: () => 0 })
    buf[344] = 0x78
    try {
      parseVolume('t.nii', toArrayBuffer(buf))
      expect.unreachable()
    } catch (e) {
      expect((e as ParseError).code).toBe('bad-magic')
    }
  })

  it('rejects garbage headers', () => {
    const junk = new ArrayBuffer(400)
    try {
      parseVolume('t.nii', junk)
      expect.unreachable()
    } catch (e) {
      expect((e as ParseError).code).toBe('bad-header')
    }
  })
})

describe('parseLabelTable', () => {
  const withTable = buildVolume({
    dims: [4, 4, 2],
    dtype: 'uint8',
    value: (i: number) => i,
    labels: [
      [1, 'region-a'],
      [2, 'region-b'],
      [17, 'region-q']
    ]
  })

  it('reads the embedded index/name table and attaches it to the volume', () => {
    const buf = toArrayBuffer(withTable)
    const table = parseLabelTable(buf)
    expect(table).not.toBeNull()
    expect(table!.size).toBe(3)
    expect(table!.get(1)).toBe('region-a')
    expect(table!.get(17)).toBe('region-q')
    expect(parseVolume('t.nii', buf).labels).toEqual(table)
  })

  it('leaves the voxel data untouched by the moved data offset', () => {
    const vol = parseVolume('t.nii', toArrayBuffer(withTable))
    expect(vol.raw[3]).toBe(3)
  })

  it('is null without the label intent code', () => {
    const plain = buildVolume({ dims: [4, 4, 2], dtype: 'uint8', value: () => 0 })
    expect(parseLabelTable(toArrayBuffer(plain))).toBeNull()
    expect(parseVolume('t.nii', toArrayBuffer(plain)).labels).toBeNull()
  })

  it('tolerates extra columns and space-delimited lines', () => {
    const buf = toArrayBuffer(withTable)
    // Rewrite the gap text in place: extra column plus a space-delimited row.
    const text = '1\tregion-a\t255 0 0\n2 region-b\nnot-a-row\n'
    const bytes = new TextEncoder().encode(text)
    new Uint8Array(buf, 352, bytes.length).set(bytes)
    const table = parseLabelTable(buf)!
    expect(table.get(1)).toBe('region-a')
    expect(table.get(2)).toBe('region-b')
    expect(table.size).toBe(2)
  })
})

describe('extractSliceToImageData', () => {
  const dims: [number, number, number] = [8, 6, 4]
  const buf = buildVolume({ dims, dtype: 'uint8', value: ramp })
  const vol = parseVolume('t.nii', toArrayBuffer(buf))
  const gray = (img: { data: Uint8ClampedArray }, p: number): number => img.data[p * 4]

  const stub = (w: number, h: number): ImageData =>
    ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) as unknown as ImageData

  it('plane XY: columns follow axis 0 ramp, rows flipped', () => {
    const img = stub(8, 6)
    extractSliceToImageData(vol, PLANES[0], 2, 0, 0, 255, img)
    for (let c = 0; c < 8; c++) {
      expect(gray(img, c)).toBe(ramp(c))
      expect(gray(img, 5 * 8 + c)).toBe(ramp(c))
    }
  })

  it('plane YZ: uniform within a fixed axis-0 slice', () => {
    const img = stub(6, 4)
    extractSliceToImageData(vol, PLANES[2], 3, 0, 0, 255, img)
    const expected = ramp(3)
    for (let p = 0; p < 6 * 4; p++) expect(gray(img, p)).toBe(expected)
  })

  it('applies display range clamping', () => {
    const img = stub(8, 6)
    extractSliceToImageData(vol, PLANES[0], 0, 0, 100, 101, img)
    expect(gray(img, 0)).toBe(0) // ramp(0)=0 below lo
    expect(gray(img, 7)).toBe(0) // ramp(7)=28 below lo
  })
})
