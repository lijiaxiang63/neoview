import { describe, expect, it } from 'vitest'
import type { SegBox } from '../src/renderer/src/segmentation/segment'
import { PLANES } from '../src/renderer/src/slicing/extract'
import {
  beginBoxGesture,
  endBoxGesture,
  updateBoxGesture,
  type BeginBoxGestureInput,
  type BoxGesture
} from '../src/renderer/src/slicing/sliceGestures'

const dims: [number, number, number] = [12, 14, 16]
const baseBox: SegBox = { min: [2, 3, 4], max: [6, 8, 10] }

function begin(overrides: Partial<BeginBoxGestureInput> = {}): BoxGesture {
  return beginBoxGesture({
    point: [3, 4],
    currentBox: null,
    handle: null,
    plane: PLANES[0],
    sliceIndex: 7,
    dims,
    ...overrides
  })
}

describe('box creation', () => {
  it.each([
    [
      [3, 4],
      [8, 9]
    ],
    [
      [8, 4],
      [3, 9]
    ],
    [
      [3, 9],
      [8, 4]
    ],
    [
      [8, 9],
      [3, 4]
    ]
  ] as const)('normalizes drag direction from %j to %j', (anchor, point) => {
    const gesture = begin({ point: [...anchor] })
    const result = endBoxGesture(gesture, [...point], 1)
    expect(result).toEqual({
      box: { min: [3, 4, 7], max: [8, 9, 7] },
      finalize: true,
      slabAxis: 2
    })
  })

  it('does not create a box on click without drag', () => {
    expect(endBoxGesture(begin(), [3, 4], 3)).toEqual({
      box: null,
      finalize: false,
      slabAxis: null
    })
  })

  it('flushes the final point before ending', () => {
    const first = updateBoxGesture(begin(), [5, 6])
    expect(endBoxGesture(first.gesture, [9, 11], 1).box).toEqual({
      min: [3, 4, 7],
      max: [9, 11, 7]
    })
  })

  it('uses the same safe end transition for cancellation', () => {
    const moved = updateBoxGesture(begin(), [8, 9]).gesture
    expect(endBoxGesture(moved, null, 1).box).toEqual({ min: [3, 4, 7], max: [8, 9, 7] })
  })

  it.each([
    [3, [6, 8]],
    [4, [5, 9]]
  ] as const)('preserves existing slab behavior for depth %i', (depth, range) => {
    const result = endBoxGesture(begin(), [4, 5], depth)
    expect(result.box?.min[2]).toBe(range[0])
    expect(result.box?.max[2]).toBe(range[1])
  })

  it('clamps a slab near both volume edges', () => {
    const low = endBoxGesture(begin({ sliceIndex: 0 }), [4, 5], 5)
    const high = endBoxGesture(begin({ sliceIndex: 15 }), [4, 5], 5)
    expect([low.box?.min[2], low.box?.max[2]]).toEqual([0, 2])
    expect([high.box?.min[2], high.box?.max[2]]).toEqual([13, 15])
  })
})

describe('box move', () => {
  it('preserves box size', () => {
    const gesture = begin({ point: [3, 4], currentBox: baseBox, sliceIndex: 7 })
    expect(gesture.kind).toBe('move')
    const box = updateBoxGesture(gesture, [7, 10]).box
    expect(box).toEqual({ min: [6, 8, 4], max: [10, 13, 10] })
  })

  it.each([
    [0, [0, 3, 4], [4, 8, 10]],
    [1, [7, 3, 4], [11, 8, 10]],
    [2, [2, 0, 4], [6, 5, 10]],
    [3, [2, 8, 4], [6, 13, 10]]
  ] as const)('clamps in-plane boundary %i', (_, min, max) => {
    const gesture = begin({ point: [3, 4], currentBox: baseBox })
    const target: [number, number] =
      _ < 2 ? (_ === 0 ? [-100, 4] : [100, 4]) : _ === 2 ? [3, -100] : [3, 100]
    expect(updateBoxGesture(gesture, target).box).toEqual({ min, max })
  })

  it('covers the remaining axis boundaries in another plane', () => {
    const plane = PLANES[1]
    const gesture = begin({ point: [3, 5], currentBox: baseBox, plane, sliceIndex: 5 })
    expect(updateBoxGesture(gesture, [3, -100]).box).toEqual({
      min: [2, 3, 0],
      max: [6, 8, 6]
    })
    expect(updateBoxGesture(gesture, [3, 100]).box).toEqual({
      min: [2, 3, 9],
      max: [6, 8, 15]
    })
  })
})

describe('box resize and plane mapping', () => {
  it.each([
    [{ editCol: 'min', editRow: null }, [8, 5], { min: [6, 3, 4], max: [8, 8, 10] }],
    [{ editCol: null, editRow: 'max' }, [4, 1], { min: [2, 1, 4], max: [6, 3, 10] }],
    [{ editCol: 'max', editRow: 'min' }, [1, 12], { min: [1, 8, 4], max: [2, 12, 10] }]
  ] as const)('resizes edges and crossing handles', (handle, point, expected) => {
    const gesture = begin({ currentBox: baseBox, handle, point: [3, 4] })
    expect(gesture.kind).toBe('resize')
    expect(updateBoxGesture(gesture, [...point]).box).toEqual(expected)
  })

  it.each([PLANES[0], PLANES[1], PLANES[2]])('maps axes for $label', (plane) => {
    const gesture = begin({ point: [1, 2], plane, sliceIndex: 3 })
    const result = endBoxGesture(gesture, [4, 5], 1).box!
    expect([result.min[plane.colAxis], result.max[plane.colAxis]]).toEqual([1, 4])
    expect([result.min[plane.rowAxis], result.max[plane.rowAxis]]).toEqual([2, 5])
    expect([result.min[plane.sliceAxis], result.max[plane.sliceAxis]]).toEqual([3, 3])
  })
})
