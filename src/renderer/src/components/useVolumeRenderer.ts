import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react'
import {
  createVolumeViewController,
  type VolumeViewController,
  type VolumeViewState
} from '../render3d/volumeViewController'

export interface VolumePointerEvent {
  button: number
  clientX: number
  clientY: number
  pointerId: number
  currentTarget: HTMLElement
}

type InteractionController = Pick<
  VolumeViewController,
  'setDragging' | 'rotate' | 'dolly' | 'resetCamera'
>

export type VolumeRendererController = InteractionController &
  Pick<VolumeViewController, 'updateState' | 'setSize' | 'dispose'>

/** Pointer capture and native wheel ownership, kept independent of React. */
export class VolumeInteractionController {
  private readonly controller: InteractionController
  private readonly onDraggingChange: (dragging: boolean) => void
  private target: HTMLElement | null = null
  private pointerId: number | null = null
  private lastPointer: [number, number] = [0, 0]
  private captured: { target: HTMLElement; pointerId: number } | null = null

  constructor(
    controller: InteractionController,
    onDraggingChange: (dragging: boolean) => void = () => undefined
  ) {
    this.controller = controller
    this.onDraggingChange = onDraggingChange
  }

  attach(target: HTMLElement): void {
    if (this.target === target) return
    this.detach()
    this.target = target
    target.addEventListener('wheel', this.handleWheel, { passive: false })
  }

  detach(): void {
    this.target?.removeEventListener('wheel', this.handleWheel)
    if (this.pointerId !== null) this.finish(this.pointerId, true)
    this.releaseCapture()
    this.target = null
  }

  pointerDown(event: VolumePointerEvent): void {
    if (event.button !== 0 || this.pointerId !== null) return
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      return
    }
    this.captured = { target: event.currentTarget, pointerId: event.pointerId }
    this.pointerId = event.pointerId
    this.lastPointer = [event.clientX, event.clientY]
    this.controller.setDragging(true)
    this.onDraggingChange(true)
  }

  pointerMove(event: VolumePointerEvent): void {
    if (this.pointerId !== event.pointerId) return
    const [lastX, lastY] = this.lastPointer
    this.lastPointer = [event.clientX, event.clientY]
    this.controller.rotate(event.clientX - lastX, event.clientY - lastY)
  }

  pointerUp(event: VolumePointerEvent): void {
    this.finish(event.pointerId, true)
  }

  pointerCancel(event: VolumePointerEvent): void {
    this.finish(event.pointerId, true)
  }

  lostPointerCapture(event: VolumePointerEvent): void {
    this.finish(event.pointerId, false)
  }

  doubleClick(): void {
    this.controller.resetCamera()
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault()
    this.controller.dolly(event.deltaY)
  }

  private finish(pointerId: number, release: boolean): void {
    if (this.pointerId !== pointerId) return
    this.pointerId = null
    this.controller.setDragging(false)
    this.onDraggingChange(false)
    if (release) this.releaseCapture(pointerId)
    else if (this.captured?.pointerId === pointerId) this.captured = null
  }

  private releaseCapture(pointerId?: number): void {
    const capture = this.captured
    if (!capture || (pointerId !== undefined && capture.pointerId !== pointerId)) return
    this.captured = null
    try {
      capture.target.releasePointerCapture(capture.pointerId)
    } catch {
      // Capture can already be gone after cancellation or element removal.
    }
  }
}

export interface UseVolumeRendererResult {
  containerRef: RefObject<HTMLDivElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  unsupported: string | null
  dragging: boolean
  handlers: {
    onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void
    onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void
    onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void
    onPointerCancel(event: ReactPointerEvent<HTMLDivElement>): void
    onLostPointerCapture(event: ReactPointerEvent<HTMLDivElement>): void
    onDoubleClick(): void
  }
}

export type VolumeControllerFactory = (
  canvas: HTMLCanvasElement,
  onUnsupported: (reason: string | null) => void
) => VolumeRendererController

export interface VolumeResizeObserver {
  observe(target: HTMLElement): void
  disconnect(): void
}

export interface VolumeLifecycleEnvironment {
  createResizeObserver(callback: () => void): VolumeResizeObserver
  addWindowResizeListener(listener: () => void): void
  removeWindowResizeListener(listener: () => void): void
}

const browserLifecycleEnvironment: VolumeLifecycleEnvironment = {
  createResizeObserver: (callback) => new ResizeObserver(callback),
  addWindowResizeListener: (listener) => window.addEventListener('resize', listener),
  removeWindowResizeListener: (listener) => window.removeEventListener('resize', listener)
}

/** Owns the resources acquired by one hook effect setup. */
export class VolumeRendererLifecycle {
  readonly interaction: VolumeInteractionController
  private readonly controller: VolumeRendererController
  private readonly container: HTMLElement
  private readonly environment: VolumeLifecycleEnvironment
  private readonly observer: VolumeResizeObserver
  private readonly updateSize: () => void
  private active = true

  constructor(
    container: HTMLElement,
    canvas: HTMLCanvasElement,
    createController: VolumeControllerFactory,
    onUnsupported: (reason: string | null) => void,
    onDraggingChange: (dragging: boolean) => void,
    environment: VolumeLifecycleEnvironment = browserLifecycleEnvironment
  ) {
    this.container = container
    this.environment = environment
    this.controller = createController(canvas, (reason) => {
      if (this.active) onUnsupported(reason)
    })
    this.interaction = new VolumeInteractionController(this.controller, (dragging) => {
      if (this.active) onDraggingChange(dragging)
    })
    this.interaction.attach(container)
    this.updateSize = () => {
      if (!this.active) return
      const rect = this.container.getBoundingClientRect()
      this.controller.setSize(rect.width, rect.height)
    }
    this.updateSize()
    this.observer = environment.createResizeObserver(this.updateSize)
    this.observer.observe(container)
    environment.addWindowResizeListener(this.updateSize)
  }

  updateState(state: VolumeViewState): void {
    if (this.active) this.controller.updateState(state)
  }

  dispose(): void {
    if (!this.active) return
    this.observer.disconnect()
    this.environment.removeWindowResizeListener(this.updateSize)
    // Let an active drag report its final state before callbacks are gated.
    this.interaction.detach()
    this.active = false
    this.controller.dispose()
  }
}

export function useVolumeRenderer(
  state: VolumeViewState,
  createController: VolumeControllerFactory = createVolumeViewController,
  lifecycleEnvironment: VolumeLifecycleEnvironment = browserLifecycleEnvironment
): UseVolumeRendererResult {
  const {
    volume,
    frame,
    range,
    renderMode,
    density,
    brightness,
    labelMap,
    labelMapRev,
    regions,
    regionOpacity
  } = state
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const lifecycleRef = useRef<VolumeRendererLifecycle | null>(null)
  const [unsupported, setUnsupported] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  useLayoutEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const lifecycle = new VolumeRendererLifecycle(
      container,
      canvas,
      createController,
      setUnsupported,
      setDragging,
      lifecycleEnvironment
    )
    lifecycleRef.current = lifecycle

    return () => {
      lifecycleRef.current = null
      lifecycle.dispose()
    }
  }, [createController, lifecycleEnvironment])

  // Uploads and frame conversion can be large, so state sync stays passive and
  // never blocks the commit that updates the slice views and controls.
  useEffect(() => {
    lifecycleRef.current?.updateState({
      volume,
      frame,
      range,
      renderMode,
      density,
      brightness,
      labelMap,
      labelMapRev,
      regions,
      regionOpacity
    })
  }, [
    volume,
    frame,
    range,
    renderMode,
    density,
    brightness,
    labelMap,
    labelMapRev,
    regions,
    regionOpacity,
    createController,
    lifecycleEnvironment
  ])

  const handlers = useMemo(
    () => ({
      onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) =>
        lifecycleRef.current?.interaction.pointerDown(event),
      onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) =>
        lifecycleRef.current?.interaction.pointerMove(event),
      onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) =>
        lifecycleRef.current?.interaction.pointerUp(event),
      onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) =>
        lifecycleRef.current?.interaction.pointerCancel(event),
      onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) =>
        lifecycleRef.current?.interaction.lostPointerCapture(event),
      onDoubleClick: () => lifecycleRef.current?.interaction.doubleClick()
    }),
    []
  )

  return { containerRef, canvasRef, unsupported, dragging, handlers }
}
