import { describe, expect, it } from 'vitest'
import {
  MAX_RENDER_DPR,
  RENDER_SETTLE_MS,
  RenderScheduler,
  type RenderSchedulerDependencies
} from '../src/renderer/src/render3d/renderScheduler'
import type { Quality } from '../src/renderer/src/render3d/types'

class FakePlatform implements RenderSchedulerDependencies {
  private nextHandle = 1
  readonly frames = new Map<number, () => void>()
  readonly timers = new Map<number, () => void>()
  readonly cancelledFrames: number[] = []
  readonly clearedTimers: number[] = []
  readonly sizes: Array<[number, number, number]> = []
  readonly renders: Quality[] = []
  devicePixelRatio = 3

  requestAnimationFrame(callback: () => void): number {
    const handle = this.nextHandle++
    this.frames.set(handle, callback)
    return handle
  }

  cancelAnimationFrame(handle: number): void {
    this.cancelledFrames.push(handle)
    this.frames.delete(handle)
  }

  setTimeout(callback: () => void, delay: number): number {
    void delay
    const handle = this.nextHandle++
    this.timers.set(handle, callback)
    return handle
  }

  clearTimeout(handle: number): void {
    this.clearedTimers.push(handle)
    this.timers.delete(handle)
  }

  getDevicePixelRatio(): number {
    return this.devicePixelRatio
  }

  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    this.sizes.push([cssWidth, cssHeight, devicePixelRatio])
  }

  render(quality: Quality): void {
    this.renders.push(quality)
  }

  runFrame(): void {
    const entry = this.frames.entries().next().value as [number, () => void] | undefined
    if (!entry) throw new Error('expected a pending frame')
    this.frames.delete(entry[0])
    entry[1]()
  }

  runTimer(): void {
    const entry = this.timers.entries().next().value as [number, () => void] | undefined
    if (!entry) throw new Error('expected a pending timer')
    this.timers.delete(entry[0])
    entry[1]()
  }
}

function harness(): { platform: FakePlatform; scheduler: RenderScheduler } {
  const platform = new FakePlatform()
  return { platform, scheduler: new RenderScheduler(platform) }
}

describe('RenderScheduler', () => {
  it('coalesces dirty requests and lets interactive override a pending full render', () => {
    const { platform, scheduler } = harness()
    scheduler.request('full')
    scheduler.request('full')
    scheduler.request('interactive')
    expect(platform.frames.size).toBe(1)
    platform.runFrame()
    expect(platform.renders).toEqual(['interactive'])
  })

  it('uses half backing-store resolution interactively and restores full capped DPR', () => {
    const { platform, scheduler } = harness()
    scheduler.setSize(120, 80)
    platform.runFrame()
    expect(platform.sizes.at(-1)).toEqual([120, 80, MAX_RENDER_DPR])
    expect(platform.renders.at(-1)).toBe('full')

    scheduler.request('interactive')
    platform.runFrame()
    expect(platform.sizes.at(-1)).toEqual([120, 80, MAX_RENDER_DPR / 2])
    expect(platform.renders.at(-1)).toBe('interactive')
  })

  it('uses the latest size when resize notifications coalesce', () => {
    const { platform, scheduler } = harness()
    scheduler.setSize(100, 50)
    scheduler.setSize(240, 160)
    expect(platform.frames.size).toBe(1)
    platform.runFrame()
    expect(platform.sizes).toEqual([[240, 160, 2]])
  })

  it('re-arms settle across continuous interaction and never renders full while dragging', () => {
    const { platform, scheduler } = harness()
    scheduler.setDragging(true)
    scheduler.request('interactive')
    const firstTimer = [...platform.timers.keys()][0]
    scheduler.request('interactive')
    expect(platform.clearedTimers).toContain(firstTimer)
    expect(platform.timers.size).toBe(1)
    platform.runFrame()

    platform.runTimer()
    expect(platform.timers.size).toBe(1)
    expect(platform.frames.size).toBe(0)

    scheduler.setDragging(false)
    expect(platform.timers.size).toBe(1)
    platform.runTimer()
    expect(platform.frames.size).toBe(1)
    platform.runFrame()
    expect(platform.renders).toEqual(['interactive', 'full'])
  })

  it('restores full quality when settle fires before the pending frame', () => {
    const { platform, scheduler } = harness()
    scheduler.request('interactive')
    platform.runTimer()
    expect(platform.frames.size).toBe(1)
    platform.runFrame()
    expect(platform.renders).toEqual(['full'])
    expect(platform.timers.size).toBe(0)
  })

  it('ignores a replaced settle callback without losing ownership of the current timer', () => {
    const { platform, scheduler } = harness()
    scheduler.request('interactive')
    const replacedCallback = [...platform.timers.values()][0]
    scheduler.request('interactive')
    expect(platform.timers.size).toBe(1)

    replacedCallback()
    expect(platform.timers.size).toBe(1)
    scheduler.dispose()
    expect(platform.timers.size).toBe(0)
    expect(platform.clearedTimers).toHaveLength(2)
  })

  it('uses the documented settle duration', () => {
    const delays: number[] = []
    const platform = new FakePlatform()
    const scheduler = new RenderScheduler({
      ...platform,
      requestAnimationFrame: platform.requestAnimationFrame.bind(platform),
      cancelAnimationFrame: platform.cancelAnimationFrame.bind(platform),
      setTimeout: (callback, delay) => {
        delays.push(delay)
        return platform.setTimeout(callback, delay)
      },
      clearTimeout: platform.clearTimeout.bind(platform),
      getDevicePixelRatio: platform.getDevicePixelRatio.bind(platform),
      resize: platform.resize.bind(platform),
      render: platform.render.bind(platform)
    })
    scheduler.request('interactive')
    expect(delays).toEqual([RENDER_SETTLE_MS])
  })

  it('cancels resources idempotently and makes late callbacks no-ops', () => {
    const { platform, scheduler } = harness()
    scheduler.request('interactive')
    const lateFrame = [...platform.frames.values()][0]
    const lateTimer = [...platform.timers.values()][0]
    scheduler.dispose()
    scheduler.dispose()
    expect(platform.cancelledFrames).toHaveLength(1)
    expect(platform.clearedTimers).toHaveLength(1)

    lateFrame()
    lateTimer()
    scheduler.request('full')
    scheduler.setSize(1, 1)
    expect(platform.renders).toEqual([])
    expect(platform.sizes).toEqual([])
    expect(platform.frames.size).toBe(0)
    expect(platform.timers.size).toBe(0)
  })
})
