import type { Quality } from './types'

export const RENDER_SETTLE_MS = 180
export const MAX_RENDER_DPR = 2
export const INTERACTIVE_RENDER_SCALE = 0.5

export interface RenderSchedulerCallbacks {
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void
  render(quality: Quality): void
}

export interface RenderSchedulerDependencies extends RenderSchedulerCallbacks {
  requestAnimationFrame(callback: () => void): number
  cancelAnimationFrame(handle: number): void
  setTimeout(callback: () => void, delay: number): number
  clearTimeout(handle: number): void
  getDevicePixelRatio(): number
}

/**
 * Coalesces dirty renders and owns the interactive-to-full quality transition.
 * It has no DOM or WebGL dependency; browser resources enter through injected
 * callbacks and are released by an idempotent dispose().
 */
export class RenderScheduler {
  private readonly dependencies: RenderSchedulerDependencies
  private readonly settleMs: number
  private cssWidth = 0
  private cssHeight = 0
  private rafHandle: number | null = null
  private settleHandle: number | null = null
  private settleGeneration = 0
  private pendingQuality: Quality | null = null
  private interactive = false
  private dragging = false
  private disposed = false

  constructor(dependencies: RenderSchedulerDependencies, settleMs = RENDER_SETTLE_MS) {
    this.dependencies = dependencies
    this.settleMs = settleMs
  }

  setSize(cssWidth: number, cssHeight: number): void {
    if (this.disposed) return
    this.cssWidth = Math.max(0, cssWidth)
    this.cssHeight = Math.max(0, cssHeight)
    this.request('full')
  }

  request(quality: Quality): void {
    if (this.disposed) return
    if (quality === 'interactive') {
      this.interactive = true
      this.pendingQuality = 'interactive'
      this.armSettle()
    } else if (this.pendingQuality !== 'interactive') {
      this.pendingQuality = 'full'
    }
    if (this.rafHandle !== null) return
    this.rafHandle = this.dependencies.requestAnimationFrame(this.flush)
  }

  setDragging(dragging: boolean): void {
    if (this.disposed || this.dragging === dragging) return
    this.dragging = dragging
    if (dragging) return
    if (this.interactive) this.armSettle()
    else this.request('full')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.settleGeneration++
    if (this.rafHandle !== null) this.dependencies.cancelAnimationFrame(this.rafHandle)
    if (this.settleHandle !== null) this.dependencies.clearTimeout(this.settleHandle)
    this.rafHandle = null
    this.settleHandle = null
    this.pendingQuality = null
    this.interactive = false
    this.dragging = false
  }

  private readonly flush = (): void => {
    this.rafHandle = null
    if (this.disposed) return
    const quality: Quality =
      this.dragging || this.interactive || this.pendingQuality === 'interactive'
        ? 'interactive'
        : 'full'
    this.pendingQuality = null
    const dpr = Math.min(Math.max(this.dependencies.getDevicePixelRatio() || 1, 1), MAX_RENDER_DPR)
    const scale = quality === 'interactive' ? INTERACTIVE_RENDER_SCALE : 1
    this.dependencies.resize(this.cssWidth, this.cssHeight, dpr * scale)
    this.dependencies.render(quality)
  }

  private armSettle(): void {
    if (this.settleHandle !== null) this.dependencies.clearTimeout(this.settleHandle)
    const generation = ++this.settleGeneration
    this.settleHandle = this.dependencies.setTimeout(
      () => this.finishSettle(generation),
      this.settleMs
    )
  }

  private finishSettle(generation: number): void {
    if (this.disposed || generation !== this.settleGeneration) return
    this.settleHandle = null
    if (this.dragging) {
      this.armSettle()
      return
    }
    this.interactive = false
    // Settle owns the quality transition. It must replace an interactive
    // request whose rAF has not run yet, while a later interactive request can
    // still take priority and start a fresh generation.
    this.pendingQuality = 'full'
    if (this.rafHandle === null) {
      this.rafHandle = this.dependencies.requestAnimationFrame(this.flush)
    }
  }
}

export function createBrowserRenderScheduler(callbacks: RenderSchedulerCallbacks): RenderScheduler {
  return new RenderScheduler({
    ...callbacks,
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (handle) => window.clearTimeout(handle),
    getDevicePixelRatio: () => window.devicePixelRatio || 1
  })
}
