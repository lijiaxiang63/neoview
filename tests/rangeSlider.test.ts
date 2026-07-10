import { describe, expect, it, vi } from 'vitest'
import {
  RangeSliderDragController,
  type RangePointerTarget
} from '../src/renderer/src/components/RangeSlider'

class FakeTarget implements RangePointerTarget {
  readonly listeners = new Map<string, Set<EventListener>>()
  readonly released: number[] = []
  captureFails = false

  setPointerCapture(): void {
    if (this.captureFails) throw new Error('capture failed')
  }

  releasePointerCapture(pointerId: number): void {
    this.released.push(pointerId)
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string, pointerId: number, clientX = 0): void {
    const event = { pointerId, clientX } as PointerEvent
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0)
  }
}

describe('RangeSliderDragController', () => {
  it('does not register a gesture when capture fails', () => {
    const target = new FakeTarget()
    target.captureFails = true
    const move = vi.fn()

    expect(new RangeSliderDragController().start(target, 3, move)).toBe(false)
    expect(target.listenerCount()).toBe(0)
  })

  it('filters pointer ids and cleans up once on cancellation', () => {
    const target = new FakeTarget()
    const controller = new RangeSliderDragController()
    const move = vi.fn()
    expect(controller.start(target, 3, move)).toBe(true)

    target.emit('pointermove', 4, 20)
    target.emit('pointermove', 3, 30)
    target.emit('pointercancel', 3)
    target.emit('pointerup', 3)

    expect(move).toHaveBeenCalledWith(30)
    expect(move).toHaveBeenCalledTimes(1)
    expect(target.listenerCount()).toBe(0)
    expect(target.released).toEqual([3])
  })

  it('releases native listeners on dispose during a drag', () => {
    const target = new FakeTarget()
    const controller = new RangeSliderDragController()
    expect(controller.start(target, 8, vi.fn())).toBe(true)

    controller.dispose()
    controller.dispose()

    expect(target.listenerCount()).toBe(0)
    expect(target.released).toEqual([8])
  })
})
