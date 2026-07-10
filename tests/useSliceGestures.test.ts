import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../src/renderer/src/store'
import {
  SliceGestureController,
  type GesturePointerEvent,
  type GestureScheduler,
  type GestureStore
} from '../src/renderer/src/components/useSliceGestures'
import { PLANES } from '../src/renderer/src/slicing/extract'
import {
  boxCanvasRect,
  fitSliceViewport,
  type SliceViewport
} from '../src/renderer/src/slicing/viewport'
import type { Volume } from '../src/renderer/src/volume/types'

class FakeElement {
  readonly style = { cursor: '' }
  readonly listeners = new Map<string, EventListener>()
  readonly captured = new Set<number>()

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener)
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (this.listeners.get(type) === listener) this.listeners.delete(type)
  }

  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: 100, height: 100 } as DOMRect
  }

  setPointerCapture(pointerId: number): void {
    this.captured.add(pointerId)
  }

  releasePointerCapture(pointerId: number): void {
    this.captured.delete(pointerId)
  }

  wheel(deltaY: number): { prevented: boolean } {
    const result = { prevented: false }
    this.listeners.get('wheel')?.({
      deltaY,
      preventDefault: () => {
        result.prevented = true
      }
    } as WheelEvent)
    return result
  }
}

class FakeScheduler implements GestureScheduler {
  private next = 1
  readonly callbacks = new Map<number, () => void>()
  readonly cancelled: number[] = []

  request(callback: () => void): number {
    const id = this.next++
    this.callbacks.set(id, callback)
    return id
  }

  cancel(handle: number): void {
    this.cancelled.push(handle)
    this.callbacks.delete(handle)
  }

  runAll(): void {
    const callbacks = [...this.callbacks.values()]
    this.callbacks.clear()
    for (const callback of callbacks) callback()
  }
}

function volume(): Volume {
  return {
    dims: [10, 10, 10],
    frames: 1,
    spacing: [1, 1, 1],
    affine: new Float64Array(16),
    raw: new Uint8Array(1000),
    slope: 1,
    inter: 0
  } as Volume
}

function viewport(): SliceViewport {
  const fit = fitSliceViewport(100, 100, 10, 10, 1, 1, 1)
  if (!fit) throw new Error('expected fit')
  return { fit, columns: 10, rows: 10, columnSpacing: 1, rowSpacing: 1 }
}

function clientPoint(column: number, row: number): [number, number] {
  return [(column + 0.5) * 10, (8.5 - row) * 10]
}

interface Harness {
  controller: SliceGestureController
  state: AppState
  container: FakeElement
  overlay: FakeElement
  scheduler: FakeScheduler
  event(column: number, row: number, overrides?: Partial<GesturePointerEvent>): GesturePointerEvent
}

function harness(): Harness {
  const vol = volume()
  const state = {
    volume: vol,
    cross: [5, 5, 5],
    segTool: 'crosshair',
    segBox: null,
    labelMap: null,
    activeRegionId: null,
    slabDepth: 3,
    setCross: vi.fn((cross: [number, number, number]) => {
      state.cross = cross
    }),
    setHover: vi.fn(),
    setSegBox: vi.fn((box) => {
      state.segBox = box
    }),
    finalizeBox: vi.fn((box) => {
      state.segBox = box
    }),
    paintAt: vi.fn(),
    endStroke: vi.fn(),
    editRegion: vi.fn(),
    toggleMaximized: vi.fn()
  } as unknown as AppState
  const store: GestureStore = { getState: () => state }
  const container = new FakeElement()
  const overlay = new FakeElement()
  const scheduler = new FakeScheduler()
  const vp = viewport()
  const controller = new SliceGestureController(
    0,
    PLANES[0],
    store,
    { volume: state.volume, viewport: vp, devicePixelRatio: 1 },
    scheduler
  )
  controller.attach(container as unknown as HTMLElement, overlay as unknown as HTMLElement)
  return {
    controller,
    state,
    container,
    overlay,
    scheduler,
    event(column, row, overrides = {}) {
      const [clientX, clientY] = clientPoint(column, row)
      return {
        button: 0,
        altKey: false,
        clientX,
        clientY,
        pointerId: 1,
        currentTarget: container as unknown as HTMLElement,
        ...overrides
      }
    }
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('navigate gestures', () => {
  it('applies a click immediately and merges drag updates through one frame', () => {
    const h = harness()
    h.controller.pointerDown(h.event(2, 3))
    expect(h.state.cross).toEqual([2, 3, 5])
    h.controller.pointerMove(h.event(4, 5))
    h.controller.pointerMove(h.event(7, 6))
    expect(h.scheduler.callbacks).toHaveLength(1)
    h.scheduler.runAll()
    expect(h.state.cross).toEqual([7, 6, 5])
    h.controller.pointerUp(h.event(7, 6))
    expect(h.container.captured.size).toBe(0)
  })

  it('steps the slice in both wheel directions and prevents scrolling', () => {
    const h = harness()
    expect(h.container.wheel(20).prevented).toBe(true)
    expect(h.state.cross).toEqual([5, 5, 6])
    h.container.wheel(-20)
    expect(h.state.cross).toEqual([5, 5, 5])
  })

  it('updates hover in the image and clears it outside or on leave', () => {
    const h = harness()
    h.controller.pointerMove(h.event(2, 3))
    expect(h.state.setHover).toHaveBeenLastCalledWith({ view: 0, ijk: [2, 3, 5] })
    h.controller.pointerMove({ ...h.event(2, 3), clientX: -1 })
    expect(h.state.setHover).toHaveBeenLastCalledWith(null)
    h.controller.pointerLeave()
    expect(h.state.setHover).toHaveBeenLastCalledWith(null)
  })

  it('reopens a nonzero region on right click', () => {
    const h = harness()
    const labels = new Uint16Array(1000)
    labels[2 + 3 * 10 + 5 * 100] = 12
    h.state.labelMap = labels
    h.controller.pointerDown(h.event(2, 3, { button: 2 }))
    expect(h.state.editRegion).toHaveBeenCalledWith(12)
  })

  it('toggles maximize only in navigate mode', () => {
    const h = harness()
    h.controller.doubleClick()
    expect(h.state.toggleMaximized).toHaveBeenCalledWith(0)
    h.state.segTool = 'box'
    h.controller.doubleClick()
    expect(h.state.toggleMaximized).toHaveBeenCalledTimes(1)
  })
})

describe('brush gestures', () => {
  it.each([
    [0, false, false],
    [2, false, true],
    [0, true, true]
  ])('uses button %i and alt=%s with erase=%s', (button, altKey, erase) => {
    const h = harness()
    h.state.segTool = 'brush'
    h.state.activeRegionId = 1
    h.controller.pointerDown(h.event(2, 3, { button, altKey }))
    expect(h.state.paintAt).toHaveBeenCalledWith(0, [2, 3], [2, 3], erase)
    h.controller.pointerMove(h.event(5, 6, { button, altKey }))
    expect(h.state.paintAt).toHaveBeenLastCalledWith(0, [2, 3], [5, 6], erase)
    h.controller.pointerUp(h.event(5, 6, { button, altKey }))
    expect(h.state.endStroke).toHaveBeenCalledTimes(1)
  })

  it.each(['pointerup', 'pointercancel', 'lostcapture'] as const)(
    'ends an active stroke exactly once on %s',
    (ending) => {
      const h = harness()
      h.state.segTool = 'brush'
      h.state.activeRegionId = 1
      const event = h.event(2, 3)
      h.controller.pointerDown(event)
      if (ending === 'pointerup') h.controller.pointerUp(event)
      else if (ending === 'pointercancel') h.controller.pointerCancel(event)
      else {
        // A lost-capture event is delivered after the browser drops capture.
        h.container.captured.delete(event.pointerId)
        h.controller.lostPointerCapture(event)
      }
      expect(h.state.endStroke).toHaveBeenCalledTimes(1)
      expect(h.container.captured.size).toBe(0)
      h.controller.pointerUp(event)
      h.controller.pointerCancel(event)
      h.controller.lostPointerCapture(event)
      expect(h.state.endStroke).toHaveBeenCalledTimes(1)
    }
  )

  it('does not start without an active region', () => {
    const h = harness()
    h.state.segTool = 'brush'
    h.controller.pointerDown(h.event(2, 3))
    expect(h.state.paintAt).not.toHaveBeenCalled()
    expect(h.container.captured.size).toBe(0)
  })
})

describe('box gestures', () => {
  it('creates from the final pointer position and applies slab depth', () => {
    const h = harness()
    h.state.segTool = 'box'
    h.controller.pointerDown(h.event(2, 3))
    h.controller.pointerMove(h.event(4, 5))
    h.controller.pointerMove(h.event(6, 7))
    expect(h.scheduler.callbacks).toHaveLength(1)
    h.controller.pointerUp(h.event(7, 8))
    expect(h.state.finalizeBox).toHaveBeenCalledWith({ min: [2, 3, 4], max: [7, 8, 6] }, 2)
    expect(h.state.setSegBox).toHaveBeenCalledTimes(1)
    expect(h.scheduler.callbacks).toHaveLength(0)
  })

  it('clears a temporary box on click without drag', () => {
    const h = harness()
    h.state.segTool = 'box'
    h.controller.pointerDown(h.event(2, 3))
    h.controller.pointerUp(h.event(2, 3))
    expect(h.state.setSegBox).toHaveBeenLastCalledWith(null)
    expect(h.state.finalizeBox).not.toHaveBeenCalled()
  })

  it('uses the last valid box point when pointer cancellation coordinates are unreliable', () => {
    const h = harness()
    h.state.segTool = 'box'
    h.controller.pointerDown(h.event(2, 3))
    h.controller.pointerMove(h.event(4, 5))
    h.controller.pointerCancel({ ...h.event(0, 0), clientX: -500, clientY: -500 })
    expect(h.state.finalizeBox).toHaveBeenCalledWith({ min: [2, 3, 4], max: [4, 5, 6] }, 2)
    expect(h.scheduler.callbacks).toHaveLength(0)
  })

  it('moves an existing box and submits only the latest frame update', () => {
    const h = harness()
    h.state.segTool = 'box'
    h.state.segBox = { min: [2, 2, 4], max: [5, 5, 6] }
    h.controller.pointerDown(h.event(3, 3))
    h.controller.pointerMove(h.event(4, 4))
    h.controller.pointerMove(h.event(6, 6))
    h.scheduler.runAll()
    expect(h.state.setSegBox).toHaveBeenLastCalledWith({ min: [5, 5, 4], max: [8, 8, 6] })
    expect(h.state.setSegBox).toHaveBeenCalledTimes(1)
    h.controller.pointerUp(h.event(6, 6))
    expect(h.state.setSegBox).toHaveBeenCalledTimes(1)
  })

  it('does not submit an unchanged box after a move or resize click', () => {
    const move = harness()
    move.state.segTool = 'box'
    move.state.segBox = { min: [2, 2, 4], max: [5, 5, 6] }
    move.controller.pointerDown(move.event(3, 3))
    move.controller.pointerUp(move.event(3, 3))
    expect(move.state.setSegBox).not.toHaveBeenCalled()

    const resize = harness()
    resize.state.segTool = 'box'
    resize.state.segBox = { min: [2, 2, 4], max: [5, 5, 6] }
    const rect = boxCanvasRect(resize.state.segBox, PLANES[0], viewport())
    const event = { ...resize.event(0, 0), clientX: rect.x0, clientY: rect.y0 }
    resize.controller.pointerDown(event)
    resize.controller.pointerUp(event)
    expect(resize.state.setSegBox).not.toHaveBeenCalled()
  })

  it('keeps resize cursor during a handle drag and resizes the selected corner', () => {
    const h = harness()
    h.state.segTool = 'box'
    h.state.segBox = { min: [2, 2, 4], max: [5, 5, 6] }
    const rect = boxCanvasRect(h.state.segBox, PLANES[0], viewport())
    const down = { ...h.event(0, 0), clientX: rect.x0, clientY: rect.y0 }
    h.controller.pointerDown(down)
    expect(h.overlay.style.cursor).toBe('nwse-resize')
    h.controller.pointerMove({ ...down, clientX: 90, clientY: 90 })
    expect(h.overlay.style.cursor).toBe('nwse-resize')
    h.controller.pointerUp({ ...down, clientX: 90, clientY: 90 })
    expect(h.state.setSegBox).toHaveBeenLastCalledWith({ min: [5, 0, 4], max: [9, 2, 6] })
    expect(h.overlay.style.cursor).toBe('')
  })
})

describe('gesture cleanup', () => {
  it('drops a navigate frame and capture when the volume identity changes', () => {
    const h = harness()
    h.controller.pointerDown(h.event(2, 3))
    h.controller.pointerMove(h.event(7, 6))
    const replacement = volume()
    h.state.volume = replacement
    h.state.cross = [1, 1, 1]
    h.controller.updateRuntime({ volume: replacement, viewport: viewport(), devicePixelRatio: 1 })
    expect(h.scheduler.callbacks).toHaveLength(0)
    expect(h.container.captured.size).toBe(0)
    h.scheduler.runAll()
    expect(h.state.cross).toEqual([1, 1, 1])
  })

  it('detaches the wheel listener and cancels a pending frame', () => {
    const h = harness()
    h.controller.pointerDown(h.event(2, 3))
    h.controller.pointerMove(h.event(4, 5))
    h.controller.detach()
    expect(h.container.listeners.has('wheel')).toBe(false)
    expect(h.scheduler.callbacks).toHaveLength(0)
    h.scheduler.runAll()
    expect(h.state.cross).toEqual([2, 3, 5])
  })

  it('ends an open stroke once on detach and supports a StrictMode-style reattach', () => {
    const h = harness()
    h.state.segTool = 'brush'
    h.state.activeRegionId = 1
    h.controller.pointerDown(h.event(2, 3))
    h.controller.detach()
    h.controller.detach()
    expect(h.state.endStroke).toHaveBeenCalledTimes(1)
    h.controller.attach(h.container as unknown as HTMLElement, h.overlay as unknown as HTMLElement)
    expect(h.container.listeners.has('wheel')).toBe(true)
  })

  it('ends an active brush and clears capture and cursor when the tool changes', () => {
    const h = harness()
    h.state.segTool = 'brush'
    h.state.activeRegionId = 1
    h.controller.pointerDown(h.event(2, 3))
    h.overlay.style.cursor = 'move'
    h.state.segTool = 'crosshair'
    h.controller.toolChanged()
    expect(h.state.endStroke).toHaveBeenCalledTimes(1)
    expect(h.container.captured.size).toBe(0)
    expect(h.overlay.style.cursor).toBe('')
  })

  it('clears an active create box and its pending frame when the tool changes', () => {
    const h = harness()
    h.state.segTool = 'box'
    h.controller.pointerDown(h.event(2, 3))
    h.controller.pointerMove(h.event(6, 7))
    h.overlay.style.cursor = 'nwse-resize'
    h.state.segTool = 'crosshair'
    h.controller.toolChanged()
    expect(h.state.setSegBox).toHaveBeenLastCalledWith(null)
    expect(h.scheduler.callbacks).toHaveLength(0)
    expect(h.container.captured.size).toBe(0)
    expect(h.overlay.style.cursor).toBe('')
  })
})
