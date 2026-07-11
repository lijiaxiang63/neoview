import type { SegBox } from '../segmentation/segment'
import { PLANES, type PlaneSpec } from './extract'

export interface ViewportFit {
  dx: number
  dy: number
  dw: number
  dh: number
  scale: number
}

export interface SliceViewport {
  fit: ViewportFit
  columns: number
  rows: number
  columnSpacing: number
  rowSpacing: number
}

export interface ClientRectLike {
  left: number
  top: number
}

export interface CanvasRect {
  x0: number
  x1: number
  y0: number
  y1: number
}

export type BoxEdge = 'min' | 'max'

export interface ResizeHandle {
  x: number
  y: number
  editCol: BoxEdge | null
  editRow: BoxEdge | null
  cursor: 'nwse-resize' | 'nesw-resize' | 'ew-resize' | 'ns-resize'
}

/** Common physical bounds for the three slice panels. Fitting every plane
 * against these bounds gives each panel the same physical-to-screen scale. */
export function sharedSliceFitSize(
  dims: [number, number, number],
  spacing: [number, number, number],
  planes: readonly PlaneSpec[] = PLANES
): [number, number] {
  const extents = dims.map((count, axis) => count * spacing[axis])
  return [
    Math.max(...planes.map((plane) => extents[plane.colAxis])),
    Math.max(...planes.map((plane) => extents[plane.rowAxis]))
  ]
}

/** Fit the spacing-corrected slice inside the backing canvas. */
export function fitSliceViewport(
  canvasWidth: number,
  canvasHeight: number,
  columns: number,
  rows: number,
  columnSpacing: number,
  rowSpacing: number,
  fill = 0.96,
  sharedFitSize: readonly [number, number] | null = null
): ViewportFit | null {
  if (
    canvasWidth <= 0 ||
    canvasHeight <= 0 ||
    columns <= 0 ||
    rows <= 0 ||
    columnSpacing <= 0 ||
    rowSpacing <= 0
  ) {
    return null
  }
  const physicalWidth = columns * columnSpacing
  const physicalHeight = rows * rowSpacing
  const fitWidth = Math.max(physicalWidth, sharedFitSize?.[0] ?? physicalWidth)
  const fitHeight = Math.max(physicalHeight, sharedFitSize?.[1] ?? physicalHeight)
  const scale = Math.min(canvasWidth / fitWidth, canvasHeight / fitHeight) * fill
  const dw = physicalWidth * scale
  const dh = physicalHeight * scale
  return {
    dx: (canvasWidth - dw) / 2,
    dy: (canvasHeight - dh) / 2,
    dw,
    dh,
    scale
  }
}

export function clientToCanvas(
  clientX: number,
  clientY: number,
  rect: ClientRectLike,
  devicePixelRatio: number
): [number, number] {
  return [(clientX - rect.left) * devicePixelRatio, (clientY - rect.top) * devicePixelRatio]
}

export function canvasToSlicePosition(
  x: number,
  y: number,
  viewport: SliceViewport
): [number, number] {
  const { fit, columnSpacing, rowSpacing } = viewport
  return [(x - fit.dx) / (fit.scale * columnSpacing), (y - fit.dy) / (fit.scale * rowSpacing)]
}

/** Map a backing-canvas point to an in-bounds voxel through the plane directions. */
export function canvasToSliceVoxel(
  x: number,
  y: number,
  viewport: SliceViewport,
  plane: Pick<PlaneSpec, 'colDirection' | 'rowDirection'> = PLANES[0]
): [number, number] | null {
  const [columnPosition, rowPosition] = canvasToSlicePosition(x, y, viewport)
  const { columns, rows } = viewport
  if (columnPosition < 0 || columnPosition >= columns || rowPosition < 0 || rowPosition >= rows) {
    return null
  }
  const screenColumn = Math.min(columns - 1, Math.max(0, Math.floor(columnPosition)))
  const screenRow = Math.min(rows - 1, Math.max(0, Math.floor(rowPosition)))
  return [
    plane.colDirection > 0 ? screenColumn : columns - 1 - screenColumn,
    plane.rowDirection > 0 ? rows - 1 - screenRow : screenRow
  ]
}

/** Map a backing-canvas point into the nearest voxel for a bounded drag. */
export function canvasToSliceVoxelClamped(
  x: number,
  y: number,
  viewport: SliceViewport,
  plane: Pick<PlaneSpec, 'colDirection' | 'rowDirection'> = PLANES[0]
): [number, number] {
  const [columnPosition, rowPosition] = canvasToSlicePosition(x, y, viewport)
  const { columns, rows } = viewport
  const screenColumn = Math.min(columns - 1, Math.max(0, Math.floor(columnPosition)))
  const screenRow = Math.min(rows - 1, Math.max(0, Math.floor(rowPosition)))
  return [
    plane.colDirection > 0 ? screenColumn : columns - 1 - screenColumn,
    plane.rowDirection > 0 ? rows - 1 - screenRow : screenRow
  ]
}

export function clientToSliceVoxel(
  clientX: number,
  clientY: number,
  rect: ClientRectLike,
  devicePixelRatio: number,
  viewport: SliceViewport,
  plane: Pick<PlaneSpec, 'colDirection' | 'rowDirection'> = PLANES[0]
): [number, number] | null {
  const [x, y] = clientToCanvas(clientX, clientY, rect, devicePixelRatio)
  return canvasToSliceVoxel(x, y, viewport, plane)
}

export function clientToSliceVoxelClamped(
  clientX: number,
  clientY: number,
  rect: ClientRectLike,
  devicePixelRatio: number,
  viewport: SliceViewport,
  plane: Pick<PlaneSpec, 'colDirection' | 'rowDirection'> = PLANES[0]
): [number, number] {
  const [x, y] = clientToCanvas(clientX, clientY, rect, devicePixelRatio)
  return canvasToSliceVoxelClamped(x, y, viewport, plane)
}

/** Canvas position of a voxel center. */
export function sliceVoxelToCanvas(
  column: number,
  row: number,
  viewport: SliceViewport,
  plane: Pick<PlaneSpec, 'colDirection' | 'rowDirection'> = PLANES[0]
): [number, number] {
  const { fit, columns, rows, columnSpacing, rowSpacing } = viewport
  const screenColumn = plane.colDirection > 0 ? column : columns - 1 - column
  const screenRow = plane.rowDirection > 0 ? rows - 1 - row : row
  return [
    fit.dx + (screenColumn + 0.5) * columnSpacing * fit.scale,
    fit.dy + (screenRow + 0.5) * rowSpacing * fit.scale
  ]
}

export function sliceCutsBox(box: SegBox, sliceAxis: 0 | 1 | 2, sliceIndex: number): boolean {
  return sliceIndex >= box.min[sliceAxis] && sliceIndex <= box.max[sliceAxis]
}

export function slicePointInsideBox(
  box: SegBox,
  plane: Pick<PlaneSpec, 'colAxis' | 'rowAxis'>,
  point: [number, number]
): boolean {
  return (
    point[0] >= box.min[plane.colAxis] &&
    point[0] <= box.max[plane.colAxis] &&
    point[1] >= box.min[plane.rowAxis] &&
    point[1] <= box.max[plane.rowAxis]
  )
}

/** Canvas rect of inclusive voxel bounds, using cell edges rather than centers. */
export function boxCanvasRect(
  box: SegBox,
  plane: Pick<PlaneSpec, 'colAxis' | 'rowAxis' | 'colDirection' | 'rowDirection'>,
  viewport: SliceViewport
): CanvasRect {
  const { fit, rows, columnSpacing, rowSpacing } = viewport
  const rawColumnMin = box.min[plane.colAxis]
  const rawColumnMax = box.max[plane.colAxis]
  const rawRowMin = box.min[plane.rowAxis]
  const rawRowMax = box.max[plane.rowAxis]
  const columnMin = plane.colDirection > 0 ? rawColumnMin : viewport.columns - 1 - rawColumnMax
  const columnMax = plane.colDirection > 0 ? rawColumnMax : viewport.columns - 1 - rawColumnMin
  const rowMin = plane.rowDirection > 0 ? rows - 1 - rawRowMax : rawRowMin
  const rowMax = plane.rowDirection > 0 ? rows - 1 - rawRowMin : rawRowMax
  return {
    x0: fit.dx + columnMin * columnSpacing * fit.scale,
    x1: fit.dx + (columnMax + 1) * columnSpacing * fit.scale,
    y0: fit.dy + rowMin * rowSpacing * fit.scale,
    y1: fit.dy + (rowMax + 1) * rowSpacing * fit.scale
  }
}

export function resizeHandles(
  rect: CanvasRect,
  plane: Pick<PlaneSpec, 'colDirection' | 'rowDirection'> = PLANES[0]
): ResizeHandle[] {
  const middleX = (rect.x0 + rect.x1) / 2
  const middleY = (rect.y0 + rect.y1) / 2
  const leftCol: BoxEdge = plane.colDirection > 0 ? 'min' : 'max'
  const rightCol: BoxEdge = plane.colDirection > 0 ? 'max' : 'min'
  const topRow: BoxEdge = plane.rowDirection > 0 ? 'max' : 'min'
  const bottomRow: BoxEdge = plane.rowDirection > 0 ? 'min' : 'max'
  return [
    { x: rect.x0, y: rect.y0, editCol: leftCol, editRow: topRow, cursor: 'nwse-resize' },
    { x: rect.x1, y: rect.y0, editCol: rightCol, editRow: topRow, cursor: 'nesw-resize' },
    { x: rect.x0, y: rect.y1, editCol: leftCol, editRow: bottomRow, cursor: 'nesw-resize' },
    { x: rect.x1, y: rect.y1, editCol: rightCol, editRow: bottomRow, cursor: 'nwse-resize' },
    { x: middleX, y: rect.y0, editCol: null, editRow: topRow, cursor: 'ns-resize' },
    { x: middleX, y: rect.y1, editCol: null, editRow: bottomRow, cursor: 'ns-resize' },
    { x: rect.x0, y: middleY, editCol: leftCol, editRow: null, cursor: 'ew-resize' },
    { x: rect.x1, y: middleY, editCol: rightCol, editRow: null, cursor: 'ew-resize' }
  ]
}

export function hitResizeHandle(
  rect: CanvasRect,
  x: number,
  y: number,
  devicePixelRatio: number,
  plane: Pick<PlaneSpec, 'colDirection' | 'rowDirection'> = PLANES[0],
  toleranceCssPixels = 8
): ResizeHandle | null {
  const tolerance = toleranceCssPixels * devicePixelRatio
  for (const handle of resizeHandles(rect, plane)) {
    if (Math.abs(x - handle.x) <= tolerance && Math.abs(y - handle.y) <= tolerance) return handle
  }
  return null
}

export function resizeCursor(handle: Pick<ResizeHandle, 'cursor'>): string {
  return handle.cursor
}
