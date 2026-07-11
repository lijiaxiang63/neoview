import { describe, expect, it } from 'vitest'
import { sliceDirectionLabels } from '../src/renderer/src/slicing/directionLabels'
import { PLANES } from '../src/renderer/src/slicing/extract'

function affine(values: readonly number[]): Float64Array {
  return new Float64Array([
    values[0],
    values[1],
    values[2],
    0,
    values[3],
    values[4],
    values[5],
    0,
    values[6],
    values[7],
    values[8],
    0,
    0,
    0,
    0,
    1
  ])
}

describe('slice direction labels', () => {
  it('maps the three planes through a flipped axis 0', () => {
    const transform = affine([-1, 0, 0, 0, 1, 0, 0, 0, 1])
    expect(sliceDirectionLabels(transform, PLANES[0])).toEqual({
      left: 'R',
      right: 'L',
      top: 'A',
      bottom: 'P'
    })
    expect(sliceDirectionLabels(transform, PLANES[1])).toEqual({
      left: 'R',
      right: 'L',
      top: 'S',
      bottom: 'I'
    })
    expect(sliceDirectionLabels(transform, PLANES[2])).toEqual({
      left: 'P',
      right: 'A',
      top: 'S',
      bottom: 'I'
    })
  })

  it('keeps world-axis assignments unique for permuted affine columns', () => {
    const transform = affine([0, 0, -3, 2, 0, 0, 0, 4, 0])
    expect(sliceDirectionLabels(transform, PLANES[0])).toEqual({
      left: 'P',
      right: 'A',
      top: 'S',
      bottom: 'I'
    })
  })
})
