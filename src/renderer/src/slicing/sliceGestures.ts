import { clampBox, type SegBox } from '../segmentation/segment'
import type { PlaneSpec } from './extract'
import { sliceCutsBox, slicePointInsideBox, type BoxEdge } from './viewport'

export type BoxGestureKind = 'create' | 'move' | 'resize'

export interface BoxGesture {
  kind: BoxGestureKind
  anchor: [number, number]
  latest: [number, number]
  startBox: SegBox
  editCol: BoxEdge | null
  editRow: BoxEdge | null
  moved: boolean
  plane: Pick<PlaneSpec, 'sliceAxis' | 'colAxis' | 'rowAxis'>
  sliceIndex: number
  dims: [number, number, number]
}

export interface BeginBoxGestureInput {
  point: [number, number]
  currentBox: SegBox | null
  handle: { editCol: BoxEdge | null; editRow: BoxEdge | null } | null
  plane: Pick<PlaneSpec, 'sliceAxis' | 'colAxis' | 'rowAxis'>
  sliceIndex: number
  dims: [number, number, number]
}

export interface BoxGestureUpdate {
  gesture: BoxGesture
  box: SegBox
}

export interface BoxGestureEnd {
  box: SegBox | null
  finalize: boolean
  slabAxis: 0 | 1 | 2 | null
}

export function cloneBox(box: SegBox): SegBox {
  return { min: [...box.min], max: [...box.max] }
}

function createStartBox(
  point: [number, number],
  plane: Pick<PlaneSpec, 'sliceAxis' | 'colAxis' | 'rowAxis'>,
  sliceIndex: number
): SegBox {
  const box: SegBox = { min: [0, 0, 0], max: [0, 0, 0] }
  box.min[plane.colAxis] = point[0]
  box.max[plane.colAxis] = point[0]
  box.min[plane.rowAxis] = point[1]
  box.max[plane.rowAxis] = point[1]
  box.min[plane.sliceAxis] = sliceIndex
  box.max[plane.sliceAxis] = sliceIndex
  return box
}

export function beginBoxGesture(input: BeginBoxGestureInput): BoxGesture {
  const { point, currentBox, handle, plane, sliceIndex, dims } = input
  let kind: BoxGestureKind
  if (currentBox && handle) kind = 'resize'
  else if (
    currentBox &&
    sliceCutsBox(currentBox, plane.sliceAxis, sliceIndex) &&
    slicePointInsideBox(currentBox, plane, point)
  ) {
    kind = 'move'
  } else kind = 'create'

  return {
    kind,
    anchor: [...point],
    latest: [...point],
    startBox:
      currentBox && kind !== 'create'
        ? cloneBox(currentBox)
        : createStartBox(point, plane, sliceIndex),
    editCol: kind === 'resize' ? handle!.editCol : null,
    editRow: kind === 'resize' ? handle!.editRow : null,
    moved: false,
    plane,
    sliceIndex,
    dims
  }
}

export function resolveBoxGesture(gesture: BoxGesture, point: [number, number]): SegBox {
  const box = cloneBox(gesture.startBox)
  const { colAxis, rowAxis } = gesture.plane
  if (gesture.kind === 'create') {
    box.min[colAxis] = Math.min(gesture.anchor[0], point[0])
    box.max[colAxis] = Math.max(gesture.anchor[0], point[0])
    box.min[rowAxis] = Math.min(gesture.anchor[1], point[1])
    box.max[rowAxis] = Math.max(gesture.anchor[1], point[1])
  } else if (gesture.kind === 'move') {
    const columnDelta = Math.min(
      Math.max(point[0] - gesture.anchor[0], -gesture.startBox.min[colAxis]),
      gesture.dims[colAxis] - 1 - gesture.startBox.max[colAxis]
    )
    const rowDelta = Math.min(
      Math.max(point[1] - gesture.anchor[1], -gesture.startBox.min[rowAxis]),
      gesture.dims[rowAxis] - 1 - gesture.startBox.max[rowAxis]
    )
    box.min[colAxis] += columnDelta
    box.max[colAxis] += columnDelta
    box.min[rowAxis] += rowDelta
    box.max[rowAxis] += rowDelta
  } else {
    if (gesture.editCol) box[gesture.editCol][colAxis] = point[0]
    if (gesture.editRow) box[gesture.editRow][rowAxis] = point[1]
  }
  return clampBox(box, gesture.dims)
}

export function updateBoxGesture(gesture: BoxGesture, point: [number, number]): BoxGestureUpdate {
  const moved = gesture.moved || point[0] !== gesture.anchor[0] || point[1] !== gesture.anchor[1]
  const next = { ...gesture, latest: [...point] as [number, number], moved }
  return { gesture: next, box: resolveBoxGesture(next, point) }
}

/** Finish and flush the final point. Cancellation uses this same transition. */
export function endBoxGesture(
  gesture: BoxGesture,
  point: [number, number] | null,
  slabDepth: number
): BoxGestureEnd {
  const update = point
    ? updateBoxGesture(gesture, point)
    : updateBoxGesture(gesture, gesture.latest)
  if (gesture.kind === 'create' && !update.gesture.moved) {
    return { box: null, finalize: false, slabAxis: null }
  }
  const box = update.box
  if (gesture.kind !== 'create') return { box, finalize: false, slabAxis: null }
  const half = Math.floor(Math.max(1, slabDepth) / 2)
  box.min[gesture.plane.sliceAxis] = gesture.sliceIndex - half
  box.max[gesture.plane.sliceAxis] = gesture.sliceIndex + half
  return {
    box: clampBox(box, gesture.dims),
    finalize: true,
    slabAxis: gesture.plane.sliceAxis
  }
}
