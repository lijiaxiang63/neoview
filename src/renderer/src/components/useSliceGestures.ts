import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react'
import { useStore, type AppState } from '../store'
import type { Volume } from '../volume/types'
import { strides, type PlaneSpec } from '../slicing/extract'
import {
  beginBoxGesture,
  endBoxGesture,
  updateBoxGesture,
  type BoxGesture
} from '../slicing/sliceGestures'
import {
  boxCanvasRect,
  clientToCanvas,
  clientToSliceVoxel,
  clientToSliceVoxelClamped,
  hitResizeHandle,
  resizeCursor,
  sliceCutsBox,
  slicePointInsideBox,
  type SliceViewport
} from '../slicing/viewport'

type View = 0 | 1 | 2

type GestureState = Pick<
  AppState,
  | 'volume'
  | 'cross'
  | 'segTool'
  | 'segBox'
  | 'labelMap'
  | 'activeRegionId'
  | 'slabDepth'
  | 'setCross'
  | 'setHover'
  | 'setSegBox'
  | 'finalizeBox'
  | 'paintAt'
  | 'endStroke'
  | 'editRegion'
  | 'toggleMaximized'
>

export interface GestureStore {
  getState(): GestureState
}

export interface GestureScheduler {
  request(callback: () => void): number
  cancel(handle: number): void
}

export interface SliceGestureRuntime {
  volume: Volume | null
  viewport: SliceViewport | null
  devicePixelRatio: number
}

export interface GesturePointerEvent {
  button: number
  altKey: boolean
  clientX: number
  clientY: number
  pointerId: number
  currentTarget: HTMLElement
}

interface PaintingGesture {
  pointerId: number
  last: [number, number]
  erase: boolean
}

const browserScheduler: GestureScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle)
}

export class SliceGestureController {
  private readonly view: View
  private readonly plane: PlaneSpec
  private readonly store: GestureStore
  private readonly scheduler: GestureScheduler
  private runtime: SliceGestureRuntime
  private container: HTMLElement | null = null
  private overlay: HTMLElement | null = null
  private navigationPointer: number | null = null
  private painting: PaintingGesture | null = null
  private boxGesture: (BoxGesture & { pointerId: number }) | null = null
  private captured: { target: HTMLElement; pointerId: number } | null = null
  private rafHandle = 0
  private pendingPoint: [number, number] | null = null
  private pendingBox: ReturnType<typeof updateBoxGesture>['box'] | null = null
  private attached = false

  constructor(
    view: View,
    plane: PlaneSpec,
    store: GestureStore,
    runtime: SliceGestureRuntime,
    scheduler: GestureScheduler = browserScheduler
  ) {
    this.view = view
    this.plane = plane
    this.store = store
    this.runtime = runtime
    this.scheduler = scheduler
  }

  updateRuntime(runtime: SliceGestureRuntime): void {
    if (this.runtime.volume !== runtime.volume) this.cancelForVolumeChange()
    this.runtime = runtime
  }

  attach(container: HTMLElement, overlay: HTMLElement): void {
    if (this.attached && this.container === container && this.overlay === overlay) return
    if (this.attached) this.detach()
    this.container = container
    this.overlay = overlay
    this.attached = true
    container.addEventListener('wheel', this.handleWheel, { passive: false })
  }

  detach(): void {
    if (!this.attached) return
    this.container?.removeEventListener('wheel', this.handleWheel)
    this.cancelScheduled()
    const state = this.store.getState()
    if (this.painting) {
      this.painting = null
      state.endStroke()
    }
    if (this.boxGesture?.kind === 'create') state.setSegBox(null)
    this.boxGesture = null
    this.navigationPointer = null
    this.releaseCapture()
    this.setCursor('')
    this.container = null
    this.overlay = null
    this.attached = false
  }

  toolChanged(): void {
    if (!this.attached) return
    const tool = this.store.getState().segTool
    if (this.painting && tool !== 'brush') {
      this.painting = null
      this.store.getState().endStroke()
      this.releaseCapture()
    }
    if (this.boxGesture && tool !== 'box') {
      const clear = this.boxGesture.kind === 'create'
      this.boxGesture = null
      this.cancelScheduled()
      if (clear) this.store.getState().setSegBox(null)
      this.releaseCapture()
    }
    if (this.navigationPointer !== null && tool !== 'crosshair') {
      this.navigationPointer = null
      this.cancelScheduled()
      this.releaseCapture()
    }
    this.setCursor('')
  }

  pointerDown(event: GesturePointerEvent): void {
    const geometry = this.geometry()
    if (!geometry) return
    const state = this.store.getState()

    if (state.segTool === 'brush') {
      if ((event.button !== 0 && event.button !== 2) || this.painting) return
      const point = this.point(event)
      if (!point || state.activeRegionId === null) return
      this.painting = {
        pointerId: event.pointerId,
        last: point,
        erase: event.button === 2 || event.altKey
      }
      if (!this.capture(event.currentTarget, event.pointerId)) {
        this.painting = null
        state.paintAt(this.view, point, point, event.button === 2 || event.altKey)
        state.endStroke()
        return
      }
      state.paintAt(this.view, point, point, this.painting.erase)
      return
    }

    if (state.segTool === 'crosshair' && event.button === 2) {
      const point = this.point(event)
      if (!point || !state.labelMap) return
      const stride = strides(geometry.volume.dims)
      const id =
        state.labelMap[
          point[0] * stride[this.plane.colAxis] +
            point[1] * stride[this.plane.rowAxis] +
            state.cross[this.plane.sliceAxis] * stride[this.plane.sliceAxis]
        ]
      if (id !== 0) state.editRegion(id)
      return
    }

    if (event.button !== 0) return

    if (state.segTool === 'box') {
      if (this.boxGesture) return
      const point = this.clampedPoint(event)
      if (!point) return
      const canvasPoint = this.canvasPoint(event)
      if (!canvasPoint) return
      const sliceIndex = state.cross[this.plane.sliceAxis]
      const handle =
        state.segBox && sliceCutsBox(state.segBox, this.plane.sliceAxis, sliceIndex)
          ? hitResizeHandle(
              boxCanvasRect(state.segBox, this.plane, geometry.viewport),
              canvasPoint[0],
              canvasPoint[1],
              geometry.devicePixelRatio
            )
          : null
      const gesture = beginBoxGesture({
        point,
        currentBox: state.segBox,
        handle,
        plane: this.plane,
        sliceIndex,
        dims: geometry.volume.dims
      })
      if (!this.capture(event.currentTarget, event.pointerId)) return
      this.boxGesture = { ...gesture, pointerId: event.pointerId }
      if (gesture.kind === 'resize' && handle) this.setCursor(resizeCursor(handle))
      if (gesture.kind === 'create') state.setSegBox(gesture.startBox)
      return
    }

    const point = this.point(event)
    if (!point) return
    if (this.navigationPointer !== null) return
    if (this.capture(event.currentTarget, event.pointerId)) {
      this.navigationPointer = event.pointerId
    }
    this.applyCross(point)
  }

  pointerMove(event: GesturePointerEvent): void {
    const state = this.store.getState()
    const point = this.point(event)
    if (point) {
      const ijk: [number, number, number] = [...state.cross]
      ijk[this.plane.colAxis] = point[0]
      ijk[this.plane.rowAxis] = point[1]
      state.setHover({ view: this.view, ijk })
    } else state.setHover(null)

    if (this.painting) {
      if (event.pointerId !== this.painting.pointerId || !point) return
      state.paintAt(this.view, this.painting.last, point, this.painting.erase)
      this.painting.last = point
      return
    }

    if (this.boxGesture) {
      if (event.pointerId !== this.boxGesture.pointerId) return
      const clamped = this.clampedPoint(event)
      if (!clamped) return
      const update = updateBoxGesture(this.boxGesture, clamped)
      this.boxGesture = { ...update.gesture, pointerId: event.pointerId }
      this.pendingBox = update.box
      this.scheduleFlush()
      return
    }

    if (state.segTool === 'box') this.updateBoxCursor(event, point)

    if (this.navigationPointer !== event.pointerId || !point) return
    this.pendingPoint = point
    this.scheduleFlush()
  }

  pointerUp(event: GesturePointerEvent): void {
    this.finishPointer(event, true, true)
  }

  pointerCancel(event: GesturePointerEvent): void {
    this.finishPointer(event, true, false)
  }

  lostPointerCapture(event: GesturePointerEvent): void {
    this.finishPointer(event, false, false)
  }

  pointerLeave(): void {
    if (!this.attached) return
    this.store.getState().setHover(null)
    if (!this.boxGesture) this.setCursor('')
  }

  doubleClick(): void {
    if (this.store.getState().segTool === 'crosshair') {
      this.store.getState().toggleMaximized(this.view)
    }
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const state = this.store.getState()
    if (!state.volume || event.deltaY === 0) return
    const next: [number, number, number] = [...state.cross]
    next[this.plane.sliceAxis] += Math.sign(event.deltaY)
    state.setCross(next)
  }

  private geometry(): (SliceGestureRuntime & { volume: Volume; viewport: SliceViewport }) | null {
    const runtime = this.runtime
    const volume = this.store.getState().volume
    if (!runtime.viewport || !volume || runtime.volume !== volume) return null
    return { ...runtime, volume, viewport: runtime.viewport }
  }

  private canvasPoint(
    event: Pick<GesturePointerEvent, 'clientX' | 'clientY'>
  ): [number, number] | null {
    const geometry = this.geometry()
    const container = this.container
    if (!geometry || !container) return null
    return clientToCanvas(
      event.clientX,
      event.clientY,
      container.getBoundingClientRect(),
      geometry.devicePixelRatio
    )
  }

  private point(event: Pick<GesturePointerEvent, 'clientX' | 'clientY'>): [number, number] | null {
    const geometry = this.geometry()
    const container = this.container
    if (!geometry || !container) return null
    return clientToSliceVoxel(
      event.clientX,
      event.clientY,
      container.getBoundingClientRect(),
      geometry.devicePixelRatio,
      geometry.viewport
    )
  }

  private clampedPoint(
    event: Pick<GesturePointerEvent, 'clientX' | 'clientY'>
  ): [number, number] | null {
    const geometry = this.geometry()
    const container = this.container
    if (!geometry || !container) return null
    return clientToSliceVoxelClamped(
      event.clientX,
      event.clientY,
      container.getBoundingClientRect(),
      geometry.devicePixelRatio,
      geometry.viewport
    )
  }

  private applyCross(point: [number, number]): void {
    const state = this.store.getState()
    const next: [number, number, number] = [...state.cross]
    next[this.plane.colAxis] = point[0]
    next[this.plane.rowAxis] = point[1]
    state.setCross(next)
  }

  private scheduleFlush(): void {
    if (!this.attached || this.rafHandle) return
    this.rafHandle = this.scheduler.request(() => this.flushPending())
  }

  private flushPending(): void {
    this.rafHandle = 0
    if (!this.attached) {
      this.pendingPoint = null
      this.pendingBox = null
      return
    }
    if (this.pendingPoint) {
      const point = this.pendingPoint
      this.pendingPoint = null
      this.applyCross(point)
    }
    if (this.pendingBox) {
      const box = this.pendingBox
      this.pendingBox = null
      this.store.getState().setSegBox(box)
    }
  }

  private cancelScheduled(): void {
    if (this.rafHandle) this.scheduler.cancel(this.rafHandle)
    this.rafHandle = 0
    this.pendingPoint = null
    this.pendingBox = null
  }

  private finishPointer(
    event: GesturePointerEvent,
    release: boolean,
    useEventPoint: boolean
  ): void {
    if (this.navigationPointer === event.pointerId) {
      this.flushScheduledNow()
      this.navigationPointer = null
      if (release) this.releaseCapture(event.pointerId)
    }
    if (this.painting?.pointerId === event.pointerId) {
      this.painting = null
      this.store.getState().endStroke()
      if (release) this.releaseCapture(event.pointerId)
    }
    if (this.boxGesture?.pointerId === event.pointerId) {
      const gesture = this.boxGesture
      this.boxGesture = null
      this.cancelScheduled()
      const result = endBoxGesture(
        gesture,
        useEventPoint ? this.clampedPoint(event) : null,
        this.store.getState().slabDepth
      )
      const state = this.store.getState()
      if (!result.box) state.setSegBox(null)
      else if (result.finalize && result.slabAxis !== null) {
        state.finalizeBox(result.box, result.slabAxis)
      } else if (!sameBox(result.box, state.segBox)) state.setSegBox(result.box)
      this.setCursor('')
      if (release) this.releaseCapture(event.pointerId)
    }
    if (!release && this.captured?.pointerId === event.pointerId) this.captured = null
  }

  private flushScheduledNow(): void {
    if (this.rafHandle) this.scheduler.cancel(this.rafHandle)
    this.rafHandle = 0
    this.flushPending()
  }

  private updateBoxCursor(event: GesturePointerEvent, point: [number, number] | null): void {
    const geometry = this.geometry()
    const state = this.store.getState()
    const canvasPoint = this.canvasPoint(event)
    if (!geometry || !canvasPoint) return
    const sliceIndex = state.cross[this.plane.sliceAxis]
    const insideSlice = state.segBox && sliceCutsBox(state.segBox, this.plane.sliceAxis, sliceIndex)
    const handle =
      state.segBox && insideSlice
        ? hitResizeHandle(
            boxCanvasRect(state.segBox, this.plane, geometry.viewport),
            canvasPoint[0],
            canvasPoint[1],
            geometry.devicePixelRatio
          )
        : null
    if (handle) this.setCursor(resizeCursor(handle))
    else if (
      state.segBox &&
      insideSlice &&
      point &&
      slicePointInsideBox(state.segBox, this.plane, point)
    ) {
      this.setCursor('move')
    } else this.setCursor('')
  }

  private capture(target: HTMLElement, pointerId: number): boolean {
    try {
      target.setPointerCapture(pointerId)
      this.captured = { target, pointerId }
      return true
    } catch {
      this.captured = null
      return false
    }
  }

  private releaseCapture(pointerId?: number): void {
    const capture = this.captured
    if (!capture || (pointerId !== undefined && capture.pointerId !== pointerId)) return
    this.captured = null
    try {
      capture.target.releasePointerCapture(capture.pointerId)
    } catch {
      // The browser may already have released it.
    }
  }

  private setCursor(cursor: string): void {
    if (this.overlay && this.overlay.style.cursor !== cursor) this.overlay.style.cursor = cursor
  }

  private cancelForVolumeChange(): void {
    this.cancelScheduled()
    this.navigationPointer = null
    if (this.painting) {
      this.painting = null
      this.store.getState().endStroke()
    }
    this.boxGesture = null
    this.releaseCapture()
    this.setCursor('')
  }
}

function sameBox(
  left: NonNullable<GestureState['segBox']>,
  right: GestureState['segBox']
): boolean {
  return (
    right !== null &&
    left.min.every((value, axis) => value === right.min[axis]) &&
    left.max.every((value, axis) => value === right.max[axis])
  )
}

export interface UseSliceGesturesInput {
  view: View
  plane: PlaneSpec
  volume: Volume | null
  viewport: SliceViewport | null
  devicePixelRatio: number
  segTool: AppState['segTool']
  containerRef: RefObject<HTMLDivElement | null>
  overlayRef: RefObject<HTMLCanvasElement | null>
}

export interface SliceGestureHandlers {
  onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void
  onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void
  onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void
  onPointerCancel(event: ReactPointerEvent<HTMLDivElement>): void
  onLostPointerCapture(event: ReactPointerEvent<HTMLDivElement>): void
  onPointerLeave(): void
  onDoubleClick(): void
}

export function useSliceGestures(input: UseSliceGesturesInput): SliceGestureHandlers {
  const [controller] = useState(
    () =>
      new SliceGestureController(input.view, input.plane, useStore, {
        volume: input.volume,
        viewport: input.viewport,
        devicePixelRatio: input.devicePixelRatio
      })
  )

  useLayoutEffect(() => {
    controller.updateRuntime({
      volume: input.volume,
      viewport: input.viewport,
      devicePixelRatio: input.devicePixelRatio
    })
  }, [controller, input.volume, input.viewport, input.devicePixelRatio])

  useEffect(() => {
    const container = input.containerRef.current
    const overlay = input.overlayRef.current
    if (!container || !overlay) return
    controller.attach(container, overlay)
    return () => controller.detach()
  }, [controller, input.containerRef, input.overlayRef])

  useEffect(() => controller.toolChanged(), [controller, input.segTool])

  return useMemo<SliceGestureHandlers>(
    () => ({
      onPointerDown: (event) => controller.pointerDown(event),
      onPointerMove: (event) => controller.pointerMove(event),
      onPointerUp: (event) => controller.pointerUp(event),
      onPointerCancel: (event) => controller.pointerCancel(event),
      onLostPointerCapture: (event) => controller.lostPointerCapture(event),
      onPointerLeave: () => controller.pointerLeave(),
      onDoubleClick: () => controller.doubleClick()
    }),
    [controller]
  )
}
