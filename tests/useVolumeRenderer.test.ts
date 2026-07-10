import { describe, expect, it, vi } from 'vitest'
import {
  VolumeInteractionController,
  VolumeRendererLifecycle,
  type VolumeControllerFactory,
  type VolumeLifecycleEnvironment,
  type VolumePointerEvent
} from '../src/renderer/src/components/useVolumeRenderer'
import type { VolumeViewState } from '../src/renderer/src/render3d/volumeViewController'

class FakeElement {
  readonly listeners = new Map<string, EventListener>()
  readonly captured = new Set<number>()
  readonly released: number[] = []
  rect = { width: 320, height: 180 }
  captureFails = false

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener)
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (this.listeners.get(type) === listener) this.listeners.delete(type)
  }

  setPointerCapture(pointerId: number): void {
    if (this.captureFails) throw new Error('capture failed')
    this.captured.add(pointerId)
  }

  releasePointerCapture(pointerId: number): void {
    this.released.push(pointerId)
    this.captured.delete(pointerId)
  }

  getBoundingClientRect(): DOMRect {
    return this.rect as DOMRect
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

class FakeLifecycleEnvironment implements VolumeLifecycleEnvironment {
  readonly observers: Array<{
    callback: () => void
    target: HTMLElement | null
    disconnected: boolean
  }> = []
  readonly windowListeners = new Set<() => void>()

  createResizeObserver(callback: () => void): {
    observe(target: HTMLElement): void
    disconnect(): void
  } {
    const record = { callback, target: null as HTMLElement | null, disconnected: false }
    this.observers.push(record)
    return {
      observe: (target) => {
        record.target = target
      },
      disconnect: () => {
        record.disconnected = true
      }
    }
  }

  addWindowResizeListener(listener: () => void): void {
    this.windowListeners.add(listener)
  }

  removeWindowResizeListener(listener: () => void): void {
    this.windowListeners.delete(listener)
  }
}

function lifecycleState(): VolumeViewState {
  return {
    volume: null,
    frame: 0,
    range: { lo: 0, hi: 1 },
    renderMode: 'mip',
    density: 0.35,
    brightness: 0.45,
    labelMap: null,
    labelMapRev: 0,
    regions: [],
    regionOpacity: 0.5
  }
}

function fakeRendererController(): {
  setDragging: ReturnType<typeof vi.fn<(dragging: boolean) => void>>
  rotate: ReturnType<typeof vi.fn<(dx: number, dy: number) => void>>
  dolly: ReturnType<typeof vi.fn<(deltaY: number) => void>>
  resetCamera: ReturnType<typeof vi.fn<() => void>>
  updateState: ReturnType<typeof vi.fn<(state: VolumeViewState) => void>>
  setSize: ReturnType<typeof vi.fn<(width: number, height: number) => void>>
  dispose: ReturnType<typeof vi.fn<() => void>>
} {
  return {
    setDragging: vi.fn<(dragging: boolean) => void>(),
    rotate: vi.fn<(dx: number, dy: number) => void>(),
    dolly: vi.fn<(deltaY: number) => void>(),
    resetCamera: vi.fn<() => void>(),
    updateState: vi.fn<(state: VolumeViewState) => void>(),
    setSize: vi.fn<(width: number, height: number) => void>(),
    dispose: vi.fn<() => void>()
  }
}

function harness(): {
  element: FakeElement
  controller: {
    setDragging: ReturnType<typeof vi.fn>
    rotate: ReturnType<typeof vi.fn>
    dolly: ReturnType<typeof vi.fn>
    resetCamera: ReturnType<typeof vi.fn>
  }
  dragging: ReturnType<typeof vi.fn>
  interactions: VolumeInteractionController
  event(overrides?: Partial<VolumePointerEvent>): VolumePointerEvent
} {
  const element = new FakeElement()
  const controller = {
    setDragging: vi.fn<(dragging: boolean) => void>(),
    rotate: vi.fn<(dx: number, dy: number) => void>(),
    dolly: vi.fn<(deltaY: number) => void>(),
    resetCamera: vi.fn<() => void>()
  }
  const dragging = vi.fn<(value: boolean) => void>()
  const interactions = new VolumeInteractionController(controller, dragging)
  interactions.attach(element as unknown as HTMLElement)
  return {
    element,
    controller,
    dragging,
    interactions,
    event(overrides = {}) {
      return {
        button: 0,
        clientX: 10,
        clientY: 20,
        pointerId: 7,
        currentTarget: element as unknown as HTMLElement,
        ...overrides
      }
    }
  }
}

describe('VolumeInteractionController', () => {
  it('starts only on the primary button, captures, and rotates from pointer deltas', () => {
    const h = harness()
    h.interactions.pointerDown(h.event({ button: 1 }))
    expect(h.controller.setDragging).not.toHaveBeenCalled()

    h.interactions.pointerDown(h.event())
    expect(h.element.captured).toEqual(new Set([7]))
    expect(h.controller.setDragging).toHaveBeenCalledWith(true)
    expect(h.dragging).toHaveBeenCalledWith(true)
    h.interactions.pointerMove(h.event({ clientX: 18, clientY: 14 }))
    expect(h.controller.rotate).toHaveBeenCalledWith(8, -6)
  })

  it('does not enter a drag when pointer capture fails', () => {
    const h = harness()
    h.element.captureFails = true

    h.interactions.pointerDown(h.event())
    h.interactions.pointerMove(h.event({ clientX: 18, clientY: 14 }))

    expect(h.controller.setDragging).not.toHaveBeenCalled()
    expect(h.dragging).not.toHaveBeenCalled()
    expect(h.controller.rotate).not.toHaveBeenCalled()
  })

  it.each(['pointerUp', 'pointerCancel', 'lostPointerCapture'] as const)(
    'ends %s exactly once and tolerates duplicate ending events',
    (method) => {
      const h = harness()
      const event = h.event()
      h.interactions.pointerDown(event)
      h.interactions[method](event)
      h.interactions[method](event)
      expect(h.controller.setDragging).toHaveBeenCalledTimes(2)
      expect(h.controller.setDragging).toHaveBeenLastCalledWith(false)
      expect(h.dragging).toHaveBeenLastCalledWith(false)
      if (method === 'lostPointerCapture') expect(h.element.released).toEqual([])
      else expect(h.element.released).toEqual([7])
    }
  )

  it('ignores moves and endings from a different pointer', () => {
    const h = harness()
    h.interactions.pointerDown(h.event())
    h.interactions.pointerMove(h.event({ pointerId: 8, clientX: 30 }))
    h.interactions.pointerUp(h.event({ pointerId: 8 }))
    expect(h.controller.rotate).not.toHaveBeenCalled()
    expect(h.element.captured).toEqual(new Set([7]))
  })

  it('prevents wheel scrolling, dollies, and resets on double-click', () => {
    const h = harness()
    expect(h.element.wheel(25).prevented).toBe(true)
    expect(h.controller.dolly).toHaveBeenCalledWith(25)
    h.interactions.doubleClick()
    expect(h.controller.resetCamera).toHaveBeenCalledTimes(1)
  })

  it('removes the native listener and safely ends a captured drag on detach', () => {
    const h = harness()
    h.interactions.pointerDown(h.event())
    h.interactions.detach()
    expect(h.element.listeners.has('wheel')).toBe(false)
    expect(h.element.captured.size).toBe(0)
    expect(h.controller.setDragging).toHaveBeenLastCalledWith(false)
    expect(h.element.wheel(10).prevented).toBe(false)
  })
})

describe('VolumeRendererLifecycle', () => {
  it('owns mount resources and gates late resize callbacks after idempotent dispose', () => {
    const element = new FakeElement()
    const environment = new FakeLifecycleEnvironment()
    const controller = fakeRendererController()
    const unsupported = vi.fn<(reason: string | null) => void>()
    const dragging = vi.fn<(value: boolean) => void>()
    const factory: VolumeControllerFactory = (_canvas, onUnsupported) => {
      onUnsupported(null)
      return controller
    }
    const lifecycle = new VolumeRendererLifecycle(
      element as unknown as HTMLElement,
      {} as HTMLCanvasElement,
      factory,
      unsupported,
      dragging,
      environment
    )
    const observerCallback = environment.observers[0].callback
    const windowCallback = [...environment.windowListeners][0]
    expect(controller.setSize).toHaveBeenCalledWith(320, 180)
    expect(environment.observers[0].target).toBe(element)
    expect(element.listeners.has('wheel')).toBe(true)
    lifecycle.updateState(lifecycleState())
    expect(controller.updateState).toHaveBeenCalledTimes(1)

    lifecycle.dispose()
    lifecycle.dispose()
    expect(environment.observers[0].disconnected).toBe(true)
    expect(environment.windowListeners.size).toBe(0)
    expect(element.listeners.has('wheel')).toBe(false)
    expect(controller.dispose).toHaveBeenCalledTimes(1)
    observerCallback()
    windowCallback()
    lifecycle.updateState(lifecycleState())
    expect(controller.setSize).toHaveBeenCalledTimes(1)
    expect(controller.updateState).toHaveBeenCalledTimes(1)
  })

  it('supports StrictMode-style setup/cleanup replay with current state on both owners', () => {
    const element = new FakeElement()
    const environment = new FakeLifecycleEnvironment()
    const controllers = [fakeRendererController(), fakeRendererController()]
    let index = 0
    const factory: VolumeControllerFactory = () => controllers[index++]
    const current = lifecycleState()

    const first = new VolumeRendererLifecycle(
      element as unknown as HTMLElement,
      {} as HTMLCanvasElement,
      factory,
      () => undefined,
      () => undefined,
      environment
    )
    first.updateState(current)
    first.dispose()
    const second = new VolumeRendererLifecycle(
      element as unknown as HTMLElement,
      {} as HTMLCanvasElement,
      factory,
      () => undefined,
      () => undefined,
      environment
    )
    second.updateState(current)
    second.dispose()

    expect(controllers[0].updateState).toHaveBeenCalledWith(current)
    expect(controllers[1].updateState).toHaveBeenCalledWith(current)
    expect(controllers[0].dispose).toHaveBeenCalledTimes(1)
    expect(controllers[1].dispose).toHaveBeenCalledTimes(1)
    expect(environment.observers.every((observer) => observer.disconnected)).toBe(true)
    expect(environment.windowListeners.size).toBe(0)
  })

  it('ends an active drag during owner replacement before gating state callbacks', () => {
    const element = new FakeElement()
    const environment = new FakeLifecycleEnvironment()
    const firstController = fakeRendererController()
    const dragging = vi.fn<(value: boolean) => void>()
    const first = new VolumeRendererLifecycle(
      element as unknown as HTMLElement,
      {} as HTMLCanvasElement,
      () => firstController,
      () => undefined,
      dragging,
      environment
    )
    first.interaction.pointerDown({
      button: 0,
      clientX: 1,
      clientY: 2,
      pointerId: 9,
      currentTarget: element as unknown as HTMLElement
    })
    first.dispose()
    expect(dragging.mock.calls).toEqual([[true], [false]])
    expect(firstController.setDragging.mock.calls).toEqual([[true], [false]])
    expect(element.captured.size).toBe(0)

    const replacement = fakeRendererController()
    const second = new VolumeRendererLifecycle(
      element as unknown as HTMLElement,
      {} as HTMLCanvasElement,
      () => replacement,
      () => undefined,
      dragging,
      environment
    )
    const current = lifecycleState()
    second.updateState(current)
    expect(replacement.updateState).toHaveBeenCalledWith(current)
    second.dispose()
  })
})
