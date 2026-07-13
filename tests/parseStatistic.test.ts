import { describe, expect, it } from 'vitest'
import { buildVolume } from '../scripts/make-test-volumes.mjs'
import { parseVolume } from '../src/renderer/src/volume/parse'
import type { Volume } from '../src/renderer/src/volume/types'

function parse(opts: Record<string, unknown>): Volume {
  const buf = buildVolume({ dims: [4, 4, 4], dtype: 'float32', value: () => 1, ...opts })
  return parseVolume('stat', buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

describe('parseVolume statistic/smoothness metadata', () => {
  it('reads a t-map with degrees of freedom from the intent fields', () => {
    const vol = parse({ intentCode: 3, intentP1: 25 })
    expect(vol.statistic).toEqual({ kind: 't', dof1: 25, dof2: null })
  })

  it('reads an F-map with numerator/denominator dof', () => {
    const vol = parse({ intentCode: 4, intentP1: 3, intentP2: 40 })
    expect(vol.statistic).toEqual({ kind: 'f', dof1: 3, dof2: 40 })
  })

  it('reads a z-map (no dof)', () => {
    const vol = parse({ intentCode: 5 })
    expect(vol.statistic).toEqual({ kind: 'z', dof1: null, dof2: null })
  })

  it('reads a p-value map', () => {
    const vol = parse({ intentCode: 22 })
    expect(vol.statistic).toEqual({ kind: 'p', dof1: null, dof2: null })
  })

  it('has no statistic when the header declares none', () => {
    const vol = parse({})
    expect(vol.statistic).toBeNull()
    expect(vol.smoothness).toBeNull()
  })

  it('parses tool metadata from the description field (dof + smoothness)', () => {
    const vol = parse({
      descrip: 'GrouVox{T_[18.0]}{dLh_0.123456}{FWHMx_8.1 FWHMy_8.2 FWHMz_7.9 mm}'
    })
    expect(vol.statistic).toEqual({ kind: 't', dof1: 18, dof2: null })
    expect(vol.smoothness?.dLh).toBeCloseTo(0.123456, 6)
    expect(vol.smoothness?.fwhm).toEqual([8.1, 8.2, 7.9])
  })

  it('lets the intent field supply dof when the description omits it', () => {
    const vol = parse({ intentCode: 3, intentP1: 12, descrip: 'plain description' })
    expect(vol.statistic).toEqual({ kind: 't', dof1: 12, dof2: null })
    expect(vol.smoothness).toBeNull()
  })
})
