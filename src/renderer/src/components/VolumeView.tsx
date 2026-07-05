import { useEffect, useRef, useState, type JSX } from 'react'
import { useStore } from '../store'
import { Raycaster, type Quality } from '../render3d/raycaster'
import { OrbitCamera, FOV_Y_RAD } from '../render3d/camera'
import { buildTexData, planTexture, scaledToNormalized, type TexPlan } from '../render3d/normalize'
import { initialTexOf } from '../volume/loadVolume'

/** Render at half resolution while interacting; restore on settle. */
const INTERACTIVE_HALF_RES = true
const SETTLE_MS = 180

export function VolumeView(): JSX.Element {
  const volume = useStore((s) => s.volume)
  const frame = useStore((s) => s.frame)
  const range = useStore((s) => s.range)
  const renderMode = useStore((s) => s.renderMode)
  const density = useStore((s) => s.density)
  const brightness = useStore((s) => s.brightness)

  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const raycasterRef = useRef<Raycaster | null>(null)
  const cameraRef = useRef(new OrbitCamera())
  const stagingRef = useRef<Uint16Array | null>(null)
  const planRef = useRef<TexPlan | null>(null)
  const rafRef = useRef(0)
  const settleTimerRef = useRef(0)
  const draggingRef = useRef(false)
  const lastPointerRef = useRef<[number, number]>([0, 0])
  const cssSizeRef = useRef<[number, number]>([0, 0])
  const interactiveRef = useRef(false)

  const [unsupported, setUnsupported] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const applySize = (quality: Quality): void => {
    const rc = raycasterRef.current
    if (!rc) return
    const [cw, ch] = cssSizeRef.current
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const scale = INTERACTIVE_HALF_RES && quality === 'interactive' ? 0.5 : 1
    rc.resize(cw, ch, dpr * scale)
  }

  const settle = (): void => {
    // Never settle to a full-quality render mid-drag: the drawing-buffer
    // realloc plus the expensive pass causes periodic hitches during slow
    // drags. Re-arm instead and settle once the pointer is released.
    if (draggingRef.current) {
      settleTimerRef.current = window.setTimeout(settle, SETTLE_MS)
      return
    }
    interactiveRef.current = false
    schedule('full')
  }

  const schedule = (quality: Quality): void => {
    const rc = raycasterRef.current
    if (!rc || rc.unsupportedReason) return
    if (quality === 'interactive') {
      interactiveRef.current = true
      window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = window.setTimeout(settle, SETTLE_MS)
    }
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      const q: Quality = interactiveRef.current ? 'interactive' : quality
      applySize(q)
      rc.setCamera(cameraRef.current.basis(), FOV_Y_RAD)
      rc.render(q)
    })
  }

  // Raycaster lifecycle.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rc = new Raycaster(canvas)
    raycasterRef.current = rc
    setUnsupported(rc.unsupportedReason)
    rc.onContextRestored = () => {
      const st = useStore.getState()
      if (st.volume) {
        rc.setWindow(
          scaledToNormalized(st.volume, st.range.lo),
          scaledToNormalized(st.volume, st.range.hi)
        )
        rc.setMode(st.renderMode)
        rc.setDensity(st.density)
        rc.setBrightness(st.brightness)
        schedule('full')
      }
    }
    return () => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      window.clearTimeout(settleTimerRef.current)
      rc.dispose()
      raycasterRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Container size tracking.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = (): void => {
      const rect = el.getBoundingClientRect()
      cssSizeRef.current = [rect.width, rect.height]
      schedule('full')
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Volume upload. Frame 0's texture payload is prebuilt in the load worker
  // so the main thread only pays for the GPU upload itself.
  useEffect(() => {
    const rc = raycasterRef.current
    if (!rc || !volume) return
    const prebuilt = initialTexOf(volume)
    const plan = prebuilt?.plan ?? planTexture(volume.dims, volume.spacing)
    planRef.current = plan
    stagingRef.current = prebuilt?.data ?? buildTexData(volume, 0, plan)
    rc.setVolume(stagingRef.current, plan.texDims, plan.texSpacing)
    setUnsupported(rc.unsupportedReason)
    cameraRef.current.reset()
    schedule('full')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume])

  // Frame change (4D).
  useEffect(() => {
    const rc = raycasterRef.current
    const plan = planRef.current
    if (!rc || !volume || volume.frames <= 1 || !plan || !stagingRef.current) return
    buildTexData(volume, frame, plan, stagingRef.current)
    rc.setFrameData(stagingRef.current)
    schedule('interactive')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, volume])

  // Display window / mode / density -> uniforms only.
  useEffect(() => {
    const rc = raycasterRef.current
    if (!rc || !volume) return
    rc.setWindow(scaledToNormalized(volume, range.lo), scaledToNormalized(volume, range.hi))
    rc.setMode(renderMode)
    rc.setDensity(density)
    rc.setBrightness(brightness)
    schedule('interactive')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, renderMode, density, brightness, volume])

  // Wheel dolly (non-passive).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      cameraRef.current.dolly(e.deltaY)
      schedule('interactive')
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    draggingRef.current = true
    setDragging(true)
    lastPointerRef.current = [e.clientX, e.clientY]
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!draggingRef.current) return
    const [lx, ly] = lastPointerRef.current
    cameraRef.current.rotate(e.clientX - lx, e.clientY - ly)
    lastPointerRef.current = [e.clientX, e.clientY]
    schedule('interactive')
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    if (!draggingRef.current) return
    draggingRef.current = false
    setDragging(false)
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }

  const onDoubleClick = (): void => {
    cameraRef.current.reset()
    schedule('full')
  }

  return (
    <div
      ref={containerRef}
      className={`volume-view${dragging ? ' dragging' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      <canvas ref={canvasRef} />
      {unsupported ? (
        <div className="volume-unsupported">{unsupported}</div>
      ) : (
        <div className="chip">
          <span className="plane-name">Volume</span>
          <span className="mono">{renderMode === 'mip' ? 'MIP' : 'Composite'}</span>
        </div>
      )}
    </div>
  )
}
