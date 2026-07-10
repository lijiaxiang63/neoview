import type { HoverInfo, SegTool } from '../store'
import type { SegBox } from '../segmentation/segment'
import type { PlaneSpec } from './extract'
import {
  boxCanvasRect,
  resizeHandles,
  sliceCutsBox,
  sliceVoxelToCanvas,
  type SliceViewport
} from './viewport'

export interface SliceAnnotationInput {
  canvasSize: [number, number]
  viewport: SliceViewport
  plane: PlaneSpec
  sliceIndex: number
  cross: [number, number, number]
  segBox: SegBox | null
  segTool: SegTool
  brushHover: HoverInfo | null
  brushRadius: number
  activeRegionId: number | null
  devicePixelRatio: number
}

export function drawSliceAnnotations(
  context: CanvasRenderingContext2D,
  input: SliceAnnotationInput
): void {
  const [canvasWidth, canvasHeight] = input.canvasSize
  const { viewport, plane, devicePixelRatio } = input
  context.clearRect(0, 0, canvasWidth, canvasHeight)
  context.save()
  try {
    const [crossX, crossY] = sliceVoxelToCanvas(
      input.cross[plane.colAxis],
      input.cross[plane.rowAxis],
      viewport
    )
    const gap = 8 * devicePixelRatio
    const imageX0 = viewport.fit.dx
    const imageX1 = viewport.fit.dx + viewport.fit.dw
    const imageY0 = viewport.fit.dy
    const imageY1 = viewport.fit.dy + viewport.fit.dh

    context.strokeStyle = 'rgba(79, 163, 255, 0.55)'
    context.lineWidth = devicePixelRatio
    context.beginPath()
    context.moveTo(crossX, imageY0)
    context.lineTo(crossX, crossY - gap)
    context.moveTo(crossX, crossY + gap)
    context.lineTo(crossX, imageY1)
    context.moveTo(imageX0, crossY)
    context.lineTo(crossX - gap, crossY)
    context.moveTo(crossX + gap, crossY)
    context.lineTo(imageX1, crossY)
    context.stroke()

    const boxInside =
      input.segBox !== null && sliceCutsBox(input.segBox, plane.sliceAxis, input.sliceIndex)
    if (input.segBox && (boxInside || input.segTool === 'box')) {
      const rect = boxCanvasRect(input.segBox, plane, viewport)
      context.lineWidth = 1.5 * devicePixelRatio
      context.strokeStyle = boxInside ? 'rgba(255, 196, 64, 0.95)' : 'rgba(255, 196, 64, 0.35)'
      context.setLineDash(boxInside ? [] : [3 * devicePixelRatio, 5 * devicePixelRatio])
      context.strokeRect(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0)
      context.setLineDash([])
      if (input.segTool === 'box' && boxInside) {
        const halfSize = 2 * devicePixelRatio
        context.fillStyle = 'rgba(255, 196, 64, 0.95)'
        for (const handle of resizeHandles(rect)) {
          context.fillRect(handle.x - halfSize, handle.y - halfSize, halfSize * 2, halfSize * 2)
        }
      }
    }

    if (input.segTool === 'brush' && input.brushHover) {
      const [brushX, brushY] = sliceVoxelToCanvas(
        input.brushHover.ijk[plane.colAxis],
        input.brushHover.ijk[plane.rowAxis],
        viewport
      )
      context.strokeStyle =
        input.activeRegionId !== null ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.3)'
      context.lineWidth = devicePixelRatio
      context.beginPath()
      context.ellipse(
        brushX,
        brushY,
        input.brushRadius * viewport.columnSpacing * viewport.fit.scale,
        input.brushRadius * viewport.rowSpacing * viewport.fit.scale,
        0,
        0,
        7
      )
      context.stroke()
    }
  } finally {
    context.setLineDash([])
    context.restore()
  }
}
