import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useStore } from '../store'
import { Raycaster, type Quality } from '../render3d/raycaster'
import { OrbitCamera, FOV_Y_RAD } from '../render3d/camera'
import {
  buildLabelTexData,
  buildTexData,
  MAX_TEX_VOXELS,
  planTexture,
  scaledToNormalized,
  type TexPlan
} from '../render3d/normalize'
import { colorComponents } from '../segmentation/regions'
import { initialTexOf } from '../volume/loadVolume'

/** Render at half resolution while interacting; restore on settle. */
const INTERACTIVE_HALF_RES = true
const SETTLE_MS = 180
/** Label-texture rebuilds trail label-map edits by this much (brush strokes
 * bump the revision on every pointer move). */
const LABEL_REBUILD_MS = 200
/** Palette size (index 0 = no region); regions beyond it stay 2D-only. */
const LABEL_PALETTE_MAX = 255

export function VolumeView(): JSX.Element {
  const volume = useStore((s) => s.volume)
  const frame = useStore((s) => s.frame)
  const range = useStore((s) => s.range)
  const renderMode = useStore((s) => s.renderMode)
  const density = useStore((s) => s.density)
  const brightness = useStore((s) => s.brightness)
  const labelMap = useStore((s) => s.labelMap)
  const labelMapRev = useStore((s) => s.labelMapRev)
  const regions = useStore((s) => s.regions)
  const regionOpacity = useStore((s) => s.regionOpacity)

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

  // Region palette (index = 1 + position in the regions list). Region ids can
  // exceed the palette; those regions simply stay 2D-only.
  //
  // Visibility enters the TEXTURE only when the volume is strided: the block
  // scan must not let a hidden region shadow a visible one sharing a block,
  // so hidden ids get no palette slot and toggles rebuild (debounced). At
  // full resolution the LUT alpha alone hides regions — no rebuild. Strided
  // ⟺ over the texture budget, the same rule planTexture applies.
  const strided = volume ? volume.dims[0] * volume.dims[1] * volume.dims[2] > MAX_TEX_VOXELS : false
  const regionIdsKey = useMemo(
    () => regions.map((r) => `${r.id}${strided && !r.visible ? '!' : ''}`).join(','),
    [regions, strided]
  )

  // Palette LUT + opacity: cheap uniform/LUT updates on color/visibility/
  // opacity changes — no texture rebuild.
  useEffect(() => {
    const rc = raycasterRef.current
    if (!rc || !volume) return
    const lut = new Uint8Array(256 * 4)
    regions.forEach((r, i) => {
      if (i >= LABEL_PALETTE_MAX) return
      const [red, green, blue] = colorComponents(r.color)
      const o = (i + 1) * 4
      lut[o] = red
      lut[o + 1] = green
      lut[o + 2] = blue
      lut[o + 3] = r.visible ? 255 : 0
    })
    rc.setLabelLut(lut)
    rc.setLabelAlpha(regionOpacity)
    schedule('interactive')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regions, regionOpacity, volume])

  // Palette-index texture: rebuilt (debounced) when the label map's voxels or
  // the region membership change. Uses the same downsampling plan as the base
  // texture so both grids align exactly.
  useEffect(() => {
    const rc = raycasterRef.current
    const plan = planRef.current
    if (!rc || !volume || !plan) return
    if (!labelMap || regions.length === 0) {
      rc.setLabelVolume(null)
      schedule('full')
      return
    }
    const timer = window.setTimeout(() => {
      const s = useStore.getState()
      if (s.volume !== volume || !s.labelMap) return
      const maxId = s.regions.reduce((m, r) => Math.max(m, r.id), 0)
      const indexOf = new Uint8Array(maxId + 1)
      const bakeVisibility = plan.stride.some((v) => v > 1)
      s.regions.forEach((r, i) => {
        if (i < LABEL_PALETTE_MAX && (!bakeVisibility || r.visible)) indexOf[r.id] = i + 1
      })
      rc.setLabelVolume(buildLabelTexData(s.labelMap, volume.dims, plan, indexOf))
      schedule('full')
    }, LABEL_REBUILD_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelMap, labelMapRev, regionIdsKey, volume])

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
