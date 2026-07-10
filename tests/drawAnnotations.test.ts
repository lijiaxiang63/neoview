import { describe, expect, it } from 'vitest'
import {
  drawSliceAnnotations,
  type SliceAnnotationInput
} from '../src/renderer/src/slicing/drawAnnotations'
import { PLANES } from '../src/renderer/src/slicing/extract'
import { fitSliceViewport, type SliceViewport } from '../src/renderer/src/slicing/viewport'

class FakeContext {
  strokeStyle: string | CanvasGradient | CanvasPattern = 'original-stroke'
  fillStyle: string | CanvasGradient | CanvasPattern = 'original-fill'
  lineWidth = 9
  readonly paths: [string, ...number[]][][] = []
  readonly rects: [number, number, number, number][] = []
  readonly fills: [number, number, number, number][] = []
  readonly ellipses: [number, number, number, number][] = []
  readonly dashes: number[][] = []
  readonly strokeStyles: string[] = []
  clearCount = 0
  private path: [string, ...number[]][] = []
  private dash: number[] = [11]
  private stack: [typeof this.strokeStyle, typeof this.fillStyle, number, number[]][] = []

  clearRect(): void {
    this.clearCount++
  }

  save(): void {
    this.stack.push([this.strokeStyle, this.fillStyle, this.lineWidth, [...this.dash]])
  }

  restore(): void {
    const state = this.stack.pop()!
    ;[this.strokeStyle, this.fillStyle, this.lineWidth, this.dash] = state
  }

  beginPath(): void {
    this.path = []
  }

  moveTo(x: number, y: number): void {
    this.path.push(['move', x, y])
  }

  lineTo(x: number, y: number): void {
    this.path.push(['line', x, y])
  }

  stroke(): void {
    this.paths.push([...this.path])
    this.strokeStyles.push(String(this.strokeStyle))
  }

  strokeRect(x: number, y: number, width: number, height: number): void {
    this.rects.push([x, y, width, height])
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.fills.push([x, y, width, height])
  }

  ellipse(x: number, y: number, rx: number, ry: number): void {
    this.ellipses.push([x, y, rx, ry])
  }

  setLineDash(dash: number[]): void {
    this.dash = [...dash]
    this.dashes.push([...dash])
  }

  getLineDash(): number[] {
    return [...this.dash]
  }
}

function viewport(): SliceViewport {
  const fit = fitSliceViewport(240, 180, 10, 8, 2, 1)
  if (!fit) throw new Error('expected a fit')
  return { fit, columns: 10, rows: 8, columnSpacing: 2, rowSpacing: 1 }
}

function input(overrides: Partial<SliceAnnotationInput> = {}): SliceAnnotationInput {
  return {
    canvasSize: [240, 180],
    viewport: viewport(),
    plane: PLANES[0],
    sliceIndex: 4,
    cross: [3, 2, 4],
    segBox: null,
    segTool: 'crosshair',
    brushHover: null,
    brushRadius: 4,
    activeRegionId: 1,
    devicePixelRatio: 2,
    ...overrides
  }
}

describe('slice annotation drawing', () => {
  it('clears each frame and draws a crosshair with a scaled center gap', () => {
    const context = new FakeContext()
    const values = input()
    drawSliceAnnotations(context as unknown as CanvasRenderingContext2D, values)
    expect(context.clearCount).toBe(1)
    const path = context.paths[0]
    expect(path).toHaveLength(8)
    const crossX = values.viewport.fit.dx + 3.5 * 2 * values.viewport.fit.scale
    const crossY = values.viewport.fit.dy + 5.5 * values.viewport.fit.scale
    expect(path).toEqual([
      ['move', crossX, values.viewport.fit.dy],
      ['line', crossX, crossY - 16],
      ['move', crossX, crossY + 16],
      ['line', crossX, values.viewport.fit.dy + values.viewport.fit.dh],
      ['move', values.viewport.fit.dx, crossY],
      ['line', crossX - 16, crossY],
      ['move', crossX + 16, crossY],
      ['line', values.viewport.fit.dx + values.viewport.fit.dw, crossY]
    ])
    const verticalGap = path[2][2] - path[1][2]
    const horizontalGap = path[6][1] - path[5][1]
    expect(verticalGap).toBe(32)
    expect(horizontalGap).toBe(32)
  })

  it('selects the second plane axes for crosshair position', () => {
    const context = new FakeContext()
    const values = input({ plane: PLANES[1] })
    drawSliceAnnotations(context as unknown as CanvasRenderingContext2D, values)
    const crossX = values.viewport.fit.dx + 3.5 * 2 * values.viewport.fit.scale
    const crossY = values.viewport.fit.dy + 3.5 * values.viewport.fit.scale
    expect(context.paths[0][0]).toEqual(['move', crossX, values.viewport.fit.dy])
    expect(context.paths[0][4]).toEqual(['move', values.viewport.fit.dx, crossY])
  })

  it('draws solid box and all eight handles inside the slab', () => {
    const context = new FakeContext()
    drawSliceAnnotations(
      context as unknown as CanvasRenderingContext2D,
      input({
        segTool: 'box',
        segBox: { min: [1, 2, 3], max: [6, 5, 7] }
      })
    )
    expect(context.rects).toHaveLength(1)
    expect(context.fills).toHaveLength(8)
    expect(context.dashes).toContainEqual([])
  })

  it('draws a scaled dashed ghost without handles outside the slab', () => {
    const context = new FakeContext()
    drawSliceAnnotations(
      context as unknown as CanvasRenderingContext2D,
      input({
        segTool: 'box',
        sliceIndex: 0,
        segBox: { min: [1, 2, 3], max: [6, 5, 7] }
      })
    )
    expect(context.rects).toHaveLength(1)
    expect(context.fills).toHaveLength(0)
    expect(context.dashes).toContainEqual([6, 10])
  })

  it('scales brush cursor radii with both spacing axes', () => {
    const context = new FakeContext()
    const values = input({
      segTool: 'brush',
      brushHover: { view: 0, ijk: [4, 5, 4] },
      brushRadius: 3
    })
    drawSliceAnnotations(context as unknown as CanvasRenderingContext2D, values)
    expect(context.ellipses).toEqual([
      [
        values.viewport.fit.dx + 4.5 * 2 * values.viewport.fit.scale,
        values.viewport.fit.dy + 2.5 * values.viewport.fit.scale,
        6 * values.viewport.fit.scale,
        3 * values.viewport.fit.scale
      ]
    ])
  })

  it('restores context state and line dash', () => {
    const context = new FakeContext()
    drawSliceAnnotations(
      context as unknown as CanvasRenderingContext2D,
      input({ segTool: 'brush', brushHover: { view: 0, ijk: [1, 1, 4] }, activeRegionId: null })
    )
    expect(context.strokeStyle).toBe('original-stroke')
    expect(context.fillStyle).toBe('original-fill')
    expect(context.lineWidth).toBe(9)
    expect(context.getLineDash()).toEqual([11])
    expect(context.strokeStyles).toContain('rgba(255, 255, 255, 0.3)')
  })
})
