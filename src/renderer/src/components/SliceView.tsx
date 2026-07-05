import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useStore } from '../store'
import { AXIS_NAMES, extractSliceToImageData, PLANES } from '../slicing/extract'

interface Fit {
  dx: number
  dy: number
  dw: number
  dh: number
  scale: number
}

interface Props {
  view: 0 | 1 | 2
}

export function SliceView({ view }: Props): JSX.Element {
  const plane = PLANES[view]
  const volume = useStore((s) => s.volume)
  const sliceIdx = useStore((s) => s.cross[plane.sliceAxis])
  const cross = useStore((s) => s.cross)
  const frame = useStore((s) => s.frame)
  const range = useStore((s) => s.range)
  const setCross = useStore((s) => s.setCross)
  const setHover = useStore((s) => s.setHover)
  const hoveredView = useStore((s) => s.hover?.view)

  const containerRef = useRef<HTMLDivElement>(null)
  const baseRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const offscreenRef = useRef<HTMLCanvasElement | null>(null)
  const imageDataRef = useRef<ImageData | null>(null)
  const draggingRef = useRef(false)
  const rafRef = useRef(0)
  const pendingPointRef = useRef<[number, number] | null>(null)

  const [size, setSize] = useState<[number, number]>([0, 0])

  const w = volume ? volume.dims[plane.colAxis] : 0
  const h = volume ? volume.dims[plane.rowAxis] : 0
  const sx = volume ? volume.spacing[plane.colAxis] : 1
  const sy = volume ? volume.spacing[plane.rowAxis] : 1

  const fit: Fit | null = useMemo(() => {
    const [cw, ch] = size
    if (!volume || cw === 0 || ch === 0) return null
    const physW = w * sx
    const physH = h * sy
    const scale = Math.min(cw / physW, ch / physH) * 0.96
    const dw = physW * scale
    const dh = physH * scale
    return { dx: (cw - dw) / 2, dy: (ch - dh) / 2, dw, dh, scale }
  }, [volume, size, w, h, sx, sy])

  // Track container size in device pixels.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = (): void => {
      const dpr = window.devicePixelRatio || 1
      const rect = el.getBoundingClientRect()
      setSize([Math.round(rect.width * dpr), Math.round(rect.height * dpr)])
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])

  const pixelToVoxel = (clientX: number, clientY: number): [number, number] | null => {
    const el = containerRef.current
    if (!el || !fit || !volume) return null
    const dpr = window.devicePixelRatio || 1
    const rect = el.getBoundingClientRect()
    const px = (clientX - rect.left) * dpr
    const py = (clientY - rect.top) * dpr
    const u = (px - fit.dx) / (fit.scale * sx)
    const v = (py - fit.dy) / (fit.scale * sy)
    if (u < 0 || u >= w || v < 0 || v >= h) return null
    const col = Math.min(w - 1, Math.max(0, Math.floor(u)))
    const row = Math.min(h - 1, Math.max(0, Math.floor(h - 1 - v)))
    return [col, row]
  }

  const voxelToPixel = (col: number, row: number): [number, number] => {
    const f = fit as Fit
    return [f.dx + (col + 0.5) * sx * f.scale, f.dy + (h - 1 - row + 0.5) * sy * f.scale]
  }

  // Base slice rendering.
  useEffect(() => {
    const canvas = baseRef.current
    if (!canvas || !volume || !fit) return
    const [cw, ch] = size
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw
      canvas.height = ch
    }
    if (!offscreenRef.current) offscreenRef.current = document.createElement('canvas')
    const off = offscreenRef.current
    if (off.width !== w || off.height !== h) {
      off.width = w
      off.height = h
      imageDataRef.current = null
    }
    if (!imageDataRef.current) imageDataRef.current = new ImageData(w, h)
    const img = imageDataRef.current

    extractSliceToImageData(volume, plane, sliceIdx, frame, range.lo, range.hi, img)
    const offCtx = off.getContext('2d') as CanvasRenderingContext2D
    offCtx.putImageData(img, 0, 0)

    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    ctx.clearRect(0, 0, cw, ch)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(off, fit.dx, fit.dy, fit.dw, fit.dh)
  }, [volume, plane, sliceIdx, frame, range, fit, size, w, h])

  // Crosshair overlay.
  useEffect(() => {
    const canvas = overlayRef.current
    if (!canvas || !volume || !fit) return
    const [cw, ch] = size
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw
      canvas.height = ch
    }
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    ctx.clearRect(0, 0, cw, ch)

    const col = cross[plane.colAxis]
    const row = cross[plane.rowAxis]
    const [cx, cy] = voxelToPixel(col, row)
    const gap = 8 * (window.devicePixelRatio || 1)
    const x0 = fit.dx
    const x1 = fit.dx + fit.dw
    const y0 = fit.dy
    const y1 = fit.dy + fit.dh

    ctx.strokeStyle = 'rgba(79, 163, 255, 0.55)'
    ctx.lineWidth = window.devicePixelRatio || 1
    ctx.beginPath()
    ctx.moveTo(cx, y0)
    ctx.lineTo(cx, cy - gap)
    ctx.moveTo(cx, cy + gap)
    ctx.lineTo(cx, y1)
    ctx.moveTo(x0, cy)
    ctx.lineTo(cx - gap, cy)
    ctx.moveTo(cx + gap, cy)
    ctx.lineTo(x1, cy)
    ctx.stroke()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume, plane, cross, fit, size])

  // Wheel needs a non-passive native listener.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const st = useStore.getState()
      const vol = st.volume
      if (!vol || e.deltaY === 0) return
      const step = Math.sign(e.deltaY)
      const next: [number, number, number] = [...st.cross]
      next[plane.sliceAxis] = next[plane.sliceAxis] + step
      st.setCross(next)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [plane.sliceAxis])

  const commitPoint = (): void => {
    rafRef.current = 0
    const pt = pendingPointRef.current
    if (!pt) return
    pendingPointRef.current = null
    const st = useStore.getState()
    const next: [number, number, number] = [...st.cross]
    next[plane.colAxis] = pt[0]
    next[plane.rowAxis] = pt[1]
    st.setCross(next)
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 || !volume) return
    const vox = pixelToVoxel(e.clientX, e.clientY)
    if (!vox) return
    draggingRef.current = true
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const next: [number, number, number] = [...useStore.getState().cross]
    next[plane.colAxis] = vox[0]
    next[plane.rowAxis] = vox[1]
    setCross(next)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!volume) return
    const vox = pixelToVoxel(e.clientX, e.clientY)
    if (vox) {
      const ijk: [number, number, number] = [...useStore.getState().cross]
      ijk[plane.colAxis] = vox[0]
      ijk[plane.rowAxis] = vox[1]
      ijk[plane.sliceAxis] = sliceIdx
      setHover({ view, ijk })
    } else {
      setHover(null)
    }
    if (!draggingRef.current) return
    if (!vox) return
    pendingPointRef.current = vox
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(commitPoint)
    }
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    if (draggingRef.current) {
      draggingRef.current = false
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    }
  }

  const onPointerLeave = (): void => {
    setHover(null)
  }

  const axisName = AXIS_NAMES[plane.sliceAxis]
  const maxSlice = volume ? volume.dims[plane.sliceAxis] - 1 : 0

  return (
    <div
      ref={containerRef}
      className={`slice-view${hoveredView === view ? ' hovered' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
    >
      <canvas ref={baseRef} />
      <canvas ref={overlayRef} className="overlay-canvas" />
      <div className="chip">
        <span className="plane-name">{plane.label}</span>
        <span className="mono">
          {axisName} {sliceIdx}/{maxSlice}
        </span>
      </div>
    </div>
  )
}
