import { describe, expect, it } from 'vitest'
import { parseVolume, serializeVolume } from '../src/renderer/src/volume/parse'

const AFFINE = new Float64Array([2, 0, 0, -10, 0, 2, 0, -20, 0, 0, 3, 5, 0, 0, 0, 1])

describe('serializeVolume', () => {
  it('round-trips a uint16 label map through the parser', () => {
    const data = new Uint16Array(2 * 3 * 4)
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) % 5
    const buf = serializeVolume({
      dims: [2, 3, 4],
      spacing: [2, 2, 3],
      affine: AFFINE,
      datatypeCode: 512,
      data
    })

    const vol = parseVolume('roundtrip', buf)
    expect(vol.dims).toEqual([2, 3, 4])
    expect(vol.frames).toBe(1)
    expect(vol.spacing).toEqual([2, 2, 3])
    expect(vol.datatypeName).toBe('uint16')
    expect(vol.slope).toBe(1)
    expect(vol.inter).toBe(0)
    expect(vol.transformSource).toBe('rows')
    expect([...vol.affine]).toEqual([...AFFINE])
    expect([...(vol.raw as Uint16Array)]).toEqual([...data])
  })

  it('round-trips a uint8 mask', () => {
    const data = new Uint8Array(3 * 3 * 3)
    data[13] = 1
    const buf = serializeVolume({
      dims: [3, 3, 3],
      spacing: [1, 1, 1],
      affine: AFFINE,
      datatypeCode: 2,
      data
    })
    const vol = parseVolume('mask', buf)
    expect(vol.datatypeName).toBe('uint8')
    expect(vol.raw[13]).toBe(1)
    expect(vol.raw[12]).toBe(0)
    expect(vol.stats.dataMax).toBe(1)
  })

  it('rejects data whose length does not match the extent', () => {
    expect(() =>
      serializeVolume({
        dims: [2, 2, 2],
        spacing: [1, 1, 1],
        affine: AFFINE,
        datatypeCode: 2,
        data: new Uint8Array(7)
      })
    ).toThrow()
  })
})
