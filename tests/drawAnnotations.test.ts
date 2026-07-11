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
  readonly texts: Array<{
    text: string
    x: number
    y: number
    kind: 'stroke' | 'fill'
    align: CanvasTextAlign
    baseline: CanvasTextBaseline
  }> = []
  font = 'original-font'
  textAlign: CanvasTextAlign = 'start'
  textBaseline: CanvasTextBaseline = 'alphabetic'
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

  strokeText(text: string, x: number, y: number): void {
    this.texts.push({
      text,
      x,
      y,
      kind: 'stroke',
      align: this.textAlign,
      baseline: this.textBaseline
    })
  }

  fillText(text: string, x: number, y: number): void {
    this.texts.push({
      text,
      x,
      y,
      kind: 'fill',
      align: this.textAlign,
      baseline: this.textBaseline
    })
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

function viewport(
  canvasWidth = 240,
  canvasHeight = 180,
  columns = 10,
  rows = 8,
  columnSpacing = 2,
  rowSpacing = 1,
  fill?: number
): SliceViewport {
  const fit = fitSliceViewport(
    canvasWidth,
    canvasHeight,
    columns,
    rows,
    columnSpacing,
    rowSpacing,
    fill
  )
  if (!fit) throw new Error('expected a fit')
  return { fit, columns, rows, columnSpacing, rowSpacing }
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
    affine: new Float64Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    directionLabelsVisible: true,
    crosshairVisible: true,
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

  it('can hide the crosshair without hiding direction labels', () => {
    const context = new FakeContext()
    drawSliceAnnotations(
      context as unknown as CanvasRenderingContext2D,
      input({ crosshairVisible: false })
    )
    expect(context.paths).toHaveLength(0)
    expect(
      context.texts.filter((entry) => entry.kind === 'fill').map((entry) => entry.text)
    ).toEqual(['R', 'A'])
  })

  it('can hide direction labels without hiding the crosshair', () => {
    const context = new FakeContext()
    drawSliceAnnotations(
      context as unknown as CanvasRenderingContext2D,
      input({ directionLabelsVisible: false })
    )
    expect(context.paths).toHaveLength(1)
    expect(context.texts).toHaveLength(0)
  })

  it('pins the two primary labels to the panel edges regardless of image fit', () => {
    const viewports = [viewport(240, 180, 10, 8, 2, 1, 0.6), viewport(240, 180, 10, 10, 1, 1)]
    for (const fittedViewport of viewports) {
      const context = new FakeContext()
      drawSliceAnnotations(
        context as unknown as CanvasRenderingContext2D,
        input({
          viewport: fittedViewport,
          crosshairVisible: false
        })
      )
      expect(context.texts.filter((entry) => entry.kind === 'fill')).toEqual([
        {
          text: 'R',
          x: 16,
          y: 90,
          kind: 'fill',
          align: 'left',
          baseline: 'middle'
        },
        {
          text: 'A',
          x: 120,
          y: 16,
          kind: 'fill',
          align: 'center',
          baseline: 'top'
        }
      ])
    }
  })

  it('scales the panel inset with the device pixel ratio', () => {
    const context = new FakeContext()
    drawSliceAnnotations(
      context as unknown as CanvasRenderingContext2D,
      input({
        canvasSize: [120, 90],
        viewport: viewport(120, 90),
        devicePixelRatio: 1,
        crosshairVisible: false
      })
    )
    expect(context.texts.filter((entry) => entry.kind === 'fill')).toMatchObject([
      { text: 'R', x: 8, y: 45, align: 'left', baseline: 'middle' },
      { text: 'A', x: 60, y: 8, align: 'center', baseline: 'top' }
    ])
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
