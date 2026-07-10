import { describe, expect, it } from 'vitest'
import type { SegBox } from '../src/renderer/src/segmentation/segment'
import { PLANES } from '../src/renderer/src/slicing/extract'
import {
  boxCanvasRect,
  canvasToSliceVoxel,
  canvasToSliceVoxelClamped,
  clientToCanvas,
  fitSliceViewport,
  hitResizeHandle,
  resizeCursor,
  resizeHandles,
  sliceCutsBox,
  sliceVoxelToCanvas,
  type SliceViewport
} from '../src/renderer/src/slicing/viewport'

function viewport(
  canvasWidth = 200,
  canvasHeight = 200,
  columns = 10,
  rows = 10,
  columnSpacing = 1,
  rowSpacing = 1
): SliceViewport {
  const fit = fitSliceViewport(canvasWidth, canvasHeight, columns, rows, columnSpacing, rowSpacing)
  if (!fit) throw new Error('expected a fit')
  return { fit, columns, rows, columnSpacing, rowSpacing }
}

describe('slice viewport fit', () => {
  it('centers a square slice in a square canvas', () => {
    const fit = viewport().fit
    expect(fit).toEqual({ dx: 4, dy: 4, dw: 192, dh: 192, scale: 19.2 })
  })

  it('uses horizontal letterboxing in a wide canvas', () => {
    const fit = viewport(300, 100).fit
    expect(fit.dy).toBeCloseTo(2)
    expect(fit.dh).toBeCloseTo(96)
    expect(fit.dx).toBeCloseTo(102)
    expect(fit.dw).toBeCloseTo(96)
  })

  it('uses vertical letterboxing in a tall canvas', () => {
    const fit = viewport(100, 300).fit
    expect(fit.dx).toBeCloseTo(2)
    expect(fit.dw).toBeCloseTo(96)
    expect(fit.dy).toBeCloseTo(102)
    expect(fit.dh).toBeCloseTo(96)
  })

  it('accounts for non-uniform spacing', () => {
    const fit = viewport(200, 200, 10, 10, 2, 1).fit
    expect(fit.dw).toBeCloseTo(192)
    expect(fit.dh).toBeCloseTo(96)
    expect(fit.dy).toBeCloseTo(52)
  })
})

describe('slice coordinate conversion', () => {
  it('maps corners and center while flipping the row axis', () => {
    const vp = viewport()
    expect(canvasToSliceVoxel(vp.fit.dx, vp.fit.dy, vp)).toEqual([0, 9])
    expect(canvasToSliceVoxel(vp.fit.dx + vp.fit.dw - 0.01, vp.fit.dy, vp)).toEqual([9, 9])
    expect(canvasToSliceVoxel(vp.fit.dx, vp.fit.dy + vp.fit.dh - 0.01, vp)).toEqual([0, 0])
    expect(
      canvasToSliceVoxel(vp.fit.dx + vp.fit.dw - 0.01, vp.fit.dy + vp.fit.dh - 0.01, vp)
    ).toEqual([9, 0])
    expect(canvasToSliceVoxel(vp.fit.dx + vp.fit.dw / 2, vp.fit.dy + vp.fit.dh / 2, vp)).toEqual([
      5, 4
    ])
    expect(sliceVoxelToCanvas(5, 5, vp)).toEqual([
      vp.fit.dx + 5.5 * vp.fit.scale,
      vp.fit.dy + 4.5 * vp.fit.scale
    ])
  })

  it('returns null outside the image and clamps bounded drags', () => {
    const vp = viewport()
    expect(canvasToSliceVoxel(vp.fit.dx - 0.01, vp.fit.dy, vp)).toBeNull()
    expect(canvasToSliceVoxel(vp.fit.dx + vp.fit.dw, vp.fit.dy, vp)).toBeNull()
    expect(canvasToSliceVoxelClamped(-100, -100, vp)).toEqual([0, 9])
    expect(canvasToSliceVoxelClamped(1000, 1000, vp)).toEqual([9, 0])
  })

  it('round trips every voxel center', () => {
    const vp = viewport(317, 181, 13, 7, 0.8, 2.3)
    for (let row = 0; row < vp.rows; row++) {
      for (let column = 0; column < vp.columns; column++) {
        const roundTrip = canvasToSliceVoxel(...sliceVoxelToCanvas(column, row, vp), vp)
        expect(roundTrip?.[0]).toBe(column)
        expect(Math.abs((roundTrip?.[1] ?? -10) - row)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('converts client coordinates using device pixel ratio', () => {
    expect(clientToCanvas(35, 50, { left: 10, top: 20 }, 2)).toEqual([50, 60])
  })
})

describe('box viewport geometry', () => {
  const box: SegBox = { min: [2, 3, 4], max: [6, 7, 8] }

  it('uses voxel cell edges for the canvas rect', () => {
    const vp = viewport(200, 200, 10, 10, 2, 1)
    const rect = boxCanvasRect(box, PLANES[0], vp)
    expect(rect.x0).toBeCloseTo(vp.fit.dx + 2 * 2 * vp.fit.scale)
    expect(rect.x1).toBeCloseTo(vp.fit.dx + 7 * 2 * vp.fit.scale)
    expect(rect.y0).toBeCloseTo(vp.fit.dy + 2 * vp.fit.scale)
    expect(rect.y1).toBeCloseTo(vp.fit.dy + 7 * vp.fit.scale)
  })

  it('includes both slice bounds', () => {
    expect(sliceCutsBox(box, 2, 3)).toBe(false)
    expect(sliceCutsBox(box, 2, 4)).toBe(true)
    expect(sliceCutsBox(box, 2, 8)).toBe(true)
    expect(sliceCutsBox(box, 2, 9)).toBe(false)
  })

  it('maps all eight handle directions and cursors', () => {
    const rect = { x0: 20, x1: 80, y0: 30, y1: 90 }
    const handles = resizeHandles(rect)
    expect(handles).toHaveLength(8)
    expect(handles.map((handle) => [handle.editCol, handle.editRow])).toEqual([
      ['min', 'max'],
      ['max', 'max'],
      ['min', 'min'],
      ['max', 'min'],
      [null, 'max'],
      [null, 'min'],
      ['min', null],
      ['max', null]
    ])
    expect(handles.map(resizeCursor)).toEqual([
      'nwse-resize',
      'nesw-resize',
      'nesw-resize',
      'nwse-resize',
      'ns-resize',
      'ns-resize',
      'ew-resize',
      'ew-resize'
    ])
  })

  it('scales handle hit tolerance with device pixel ratio', () => {
    const rect = { x0: 20, x1: 80, y0: 30, y1: 90 }
    expect(hitResizeHandle(rect, 4.1, 30, 2)?.editCol).toBe('min')
    expect(hitResizeHandle(rect, 3.9, 30, 2)).toBeNull()
    expect(hitResizeHandle(rect, 12.1, 30, 1)?.editCol).toBe('min')
    expect(hitResizeHandle(rect, 11.9, 30, 1)).toBeNull()
  })
})
