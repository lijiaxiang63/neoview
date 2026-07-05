import { describe, expect, it } from 'vitest'
// @ts-expect-error plain mjs helper shared with the fixture generator
import { buildVolume } from '../scripts/make-test-volumes.mjs'
import { parseVolume } from '../src/renderer/src/volume/parse'
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
