import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useStore } from '../store'
import { AXIS_NAMES, extractSliceToImageData, PLANES, strides } from '../slicing/extract'
import { buildMapLUT, extractOverlayRGBA } from '../slicing/overlay'
import {
  defaultRegionColor,
  extractPreviewRGBA,
  extractRegionsRGBA,
  packColor
} from '../segmentation/regions'
import type { SegBox } from '../segmentation/segment'

interface LayerBuffer {
  canvas: HTMLCanvasElement
  img: ImageData
}

interface Fit {
  dx: number
  dy: number
  dw: number
  dh: number
  scale: number
}

/** In-progress box gesture; bounds resolve against startBox on every move. */
interface BoxDrag {
  kind: 'create' | 'move' | 'resize'
  anchor: [number, number]
  startBox: SegBox
  editCol: 'min' | 'max' | null
  editRow: 'min' | 'max' | null
  moved: boolean
}

interface Props {
  view: 0 | 1 | 2
}

const HANDLE_HIT_PX = 8

export function SliceView({ view }: Props): JSX.Element {
  const plane = PLANES[view]
  const volume = useStore((s) => s.volume)
  const sliceIdx = useStore((s) => s.cross[plane.sliceAxis])
  const cross = useStore((s) => s.cross)
  const frame = useStore((s) => s.frame)
  const range = useStore((s) => s.range)
  const baseColormap = useStore((s) => s.baseColormap)
  const overlays = useStore((s) => s.overlays)
  const setCross = useStore((s) => s.setCross)
  const setHover = useStore((s) => s.setHover)
  const hoveredView = useStore((s) => s.hover?.view)
  // Full hover position only matters for the brush cursor; keeping the
  // selector narrow avoids re-rendering every view on each pointer move.
  const brushHover = useStore((s) =>
    s.segTool === 'brush' && s.hover?.view === view ? s.hover : null
  )
  const segTool = useStore((s) => s.segTool)
  const segBox = useStore((s) => s.segBox)
  const preview = useStore((s) => s.preview)
  const labelMap = useStore((s) => s.labelMap)
  const labelMapRev = useStore((s) => s.labelMapRev)
  const regions = useStore((s) => s.regions)
  const regionOpacity = useStore((s) => s.regionOpacity)
  const nextRegionId = useStore((s) => s.nextRegionId)
  const brushRadius = useStore((s) => s.brushRadius)
  const activeRegionId = useStore((s) => s.activeRegionId)
  const editRegionId = useStore((s) => s.editRegionId)
  const maximized = useStore((s) => s.maximizedView === view)

  const containerRef = useRef<HTMLDivElement>(null)
  const baseRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const offscreenRef = useRef<HTMLCanvasElement | null>(null)
  const imageDataRef = useRef<ImageData | null>(null)
  const layerBuffersRef = useRef(new Map<number, LayerBuffer>())
  const regionBufRef = useRef<LayerBuffer | null>(null)
  const previewBufRef = useRef<LayerBuffer | null>(null)
  const draggingRef = useRef(false)
  const boxDragRef = useRef<BoxDrag | null>(null)
  const paintingRef = useRef<{ last: [number, number]; erase: boolean } | null>(null)
  const rafRef = useRef(0)
  const pendingPointRef = useRef<[number, number] | null>(null)
  const pendingBoxRef = useRef<SegBox | null>(null)

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

  const pixelToUV = (clientX: number, clientY: number): [number, number] | null => {
    const el = containerRef.current
    if (!el || !fit || !volume) return null
    const dpr = window.devicePixelRatio || 1
    const rect = el.getBoundingClientRect()
    const px = (clientX - rect.left) * dpr
    const py = (clientY - rect.top) * dpr
    return [(px - fit.dx) / (fit.scale * sx), (py - fit.dy) / (fit.scale * sy)]
  }

  const pixelToVoxel = (clientX: number, clientY: number): [number, number] | null => {
    const uv = pixelToUV(clientX, clientY)
    if (!uv) return null
    const [u, v] = uv
    if (u < 0 || u >= w || v < 0 || v >= h) return null
    const col = Math.min(w - 1, Math.max(0, Math.floor(u)))
    const row = Math.min(h - 1, Math.max(0, Math.floor(h - 1 - v)))
    return [col, row]
  }

  /** Like pixelToVoxel but clamped into the slice, for box drags that stray
   * outside the letterboxed image. */
  const pixelToVoxelClamped = (clientX: number, clientY: number): [number, number] | null => {
    const uv = pixelToUV(clientX, clientY)
    if (!uv) return null
    const col = Math.min(w - 1, Math.max(0, Math.floor(uv[0])))
    const row = Math.min(h - 1, Math.max(0, Math.floor(h - 1 - uv[1])))
    return [col, row]
  }

  const voxelToPixel = (col: number, row: number): [number, number] => {
    const f = fit as Fit
    return [f.dx + (col + 0.5) * sx * f.scale, f.dy + (h - 1 - row + 0.5) * sy * f.scale]
  }

  /** The current slice cuts the box — handles and move/resize gestures only
   * exist on such slices (elsewhere the box is just a faint ghost). */
  const sliceCutsBox = (box: SegBox): boolean =>
    sliceIdx >= box.min[plane.sliceAxis] && sliceIdx <= box.max[plane.sliceAxis]

  /** Box outline in canvas px (voxel cell edges, not centers). */
  const boxRect = (box: SegBox): { x0: number; x1: number; y0: number; y1: number } => {
    const f = fit as Fit
    const cmin = box.min[plane.colAxis]
    const cmax = box.max[plane.colAxis]
    const rmin = box.min[plane.rowAxis]
    const rmax = box.max[plane.rowAxis]
    return {
      x0: f.dx + cmin * sx * f.scale,
      x1: f.dx + (cmax + 1) * sx * f.scale,
      y0: f.dy + (h - 1 - rmax) * sy * f.scale,
      y1: f.dy + (h - rmin) * sy * f.scale
    }
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

    const baseLut = baseColormap === 'gray' ? null : buildMapLUT(baseColormap).pos
    extractSliceToImageData(volume, plane, sliceIdx, frame, range.lo, range.hi, img, baseLut)
    const offCtx = off.getContext('2d') as CanvasRenderingContext2D
    offCtx.putImageData(img, 0, 0)

    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    ctx.clearRect(0, 0, cw, ch)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(off, fit.dx, fit.dy, fit.dw, fit.dh)

    // Overlay layers, bottom to top, each drawn from its own buffer at the
    // base slice grid size so it shares the letterbox fit exactly.
    const buffers = layerBuffersRef.current
    for (const id of buffers.keys()) {
      if (!overlays.some((l) => l.id === id)) buffers.delete(id)
    }
    for (const layer of overlays) {
      if (!layer.visible || layer.opacity <= 0) continue
      let buf = buffers.get(layer.id)
      if (!buf || buf.canvas.width !== w || buf.canvas.height !== h) {
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        buf = { canvas: c, img: new ImageData(w, h) }
        buffers.set(layer.id, buf)
      }
      extractOverlayRGBA(layer, volume, plane, sliceIdx, frame, buf.img)
      const layerCtx = buf.canvas.getContext('2d') as CanvasRenderingContext2D
      layerCtx.putImageData(buf.img, 0, 0)
      // Crisp voxel edges for discrete kinds; smoothing only suits continuous maps.
      ctx.imageSmoothingEnabled = layer.kind === 'map'
      ctx.globalAlpha = layer.opacity
      ctx.drawImage(buf.canvas, fit.dx, fit.dy, fit.dw, fit.dh)
    }

    const ensureBuf = (ref: React.MutableRefObject<LayerBuffer | null>): LayerBuffer => {
      let buf = ref.current
      if (!buf || buf.canvas.width !== w || buf.canvas.height !== h) {
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        buf = { canvas: c, img: new ImageData(w, h) }
        ref.current = buf
      }
      return buf
    }

    // Committed regions sit above all overlay layers.
    if (labelMap && regionOpacity > 0 && regions.some((r) => r.visible)) {
      const maxId = regions.reduce((m, r) => Math.max(m, r.id), 0)
      const colorOf = new Uint32Array(maxId + 1)
      for (const r of regions) {
        if (r.visible) colorOf[r.id] = packColor(r.color)
      }
      const buf = ensureBuf(regionBufRef)
      extractRegionsRGBA(labelMap, volume.dims, plane, sliceIdx, colorOf, buf.img)
      const bctx = buf.canvas.getContext('2d') as CanvasRenderingContext2D
      bctx.putImageData(buf.img, 0, 0)
      ctx.imageSmoothingEnabled = false
      ctx.globalAlpha = regionOpacity
      ctx.drawImage(buf.canvas, fit.dx, fit.dy, fit.dw, fit.dh)
    }

    // Pending preview on top, in the color the region will get on commit
    // (re-edits keep the target region's color).
    if (preview && preview.voxels > 0) {
      const buf = ensureBuf(previewBufRef)
      const previewColor =
        regions.find((r) => r.id === editRegionId)?.color ?? defaultRegionColor(nextRegionId)
      extractPreviewRGBA(
        preview.mask,
        preview.bounds,
        volume.dims,
        plane,
        sliceIdx,
        packColor(previewColor),
        buf.img
      )
      const bctx = buf.canvas.getContext('2d') as CanvasRenderingContext2D
      bctx.putImageData(buf.img, 0, 0)
      ctx.imageSmoothingEnabled = false
      ctx.globalAlpha = 0.7
      ctx.drawImage(buf.canvas, fit.dx, fit.dy, fit.dw, fit.dh)
    }

    ctx.globalAlpha = 1
    ctx.imageSmoothingEnabled = true
  }, [
    volume,
    plane,
    sliceIdx,
    frame,
    range,
    baseColormap,
    overlays,
    fit,
    size,
    w,
    h,
    labelMap,
    labelMapRev,
    regions,
    regionOpacity,
    preview,
    nextRegionId,
    editRegionId
  ])

  // Vector overlay: crosshair, box outline + handles, brush cursor.
  useEffect(() => {
    const canvas = overlayRef.current
    if (!canvas || !volume || !fit) return
    const [cw, ch] = size
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw
      canvas.height = ch
    }
    const dpr = window.devicePixelRatio || 1
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    ctx.clearRect(0, 0, cw, ch)

    const col = cross[plane.colAxis]
    const row = cross[plane.rowAxis]
    const [cx, cy] = voxelToPixel(col, row)
    const gap = 8 * dpr
    const x0 = fit.dx
    const x1 = fit.dx + fit.dw
    const y0 = fit.dy
    const y1 = fit.dy + fit.dh

    ctx.strokeStyle = 'rgba(79, 163, 255, 0.55)'
    ctx.lineWidth = dpr
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

    // The box outline appears only on slices the box actually cuts, so
    // scrolling shows its 3D extent. The box tool keeps a faint dashed ghost
    // outside that range so the box stays findable; handles exist only on
    // slices that cut the box — the same slices where gestures work.
    const boxInside = segBox !== null && sliceCutsBox(segBox)
    if (segBox && (boxInside || segTool === 'box')) {
      const r = boxRect(segBox)
      const inside = boxInside
      ctx.lineWidth = 1.5 * dpr
      ctx.strokeStyle = inside ? 'rgba(255, 196, 64, 0.95)' : 'rgba(255, 196, 64, 0.35)'
      ctx.setLineDash(inside ? [] : [3 * dpr, 5 * dpr])
      ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0)
      ctx.setLineDash([])
      if (segTool === 'box' && inside) {
        const mx = (r.x0 + r.x1) / 2
        const my = (r.y0 + r.y1) / 2
        const pts: [number, number][] = [
          [r.x0, r.y0],
          [mx, r.y0],
          [r.x1, r.y0],
          [r.x1, my],
          [r.x1, r.y1],
          [mx, r.y1],
          [r.x0, r.y1],
          [r.x0, my]
        ]
        const s = 2 * dpr
        ctx.fillStyle = 'rgba(255, 196, 64, 0.95)'
        for (const [hx, hy] of pts) ctx.fillRect(hx - s, hy - s, s * 2, s * 2)
      }
    }

    if (segTool === 'brush' && brushHover) {
      const [bx, by] = voxelToPixel(brushHover.ijk[plane.colAxis], brushHover.ijk[plane.rowAxis])
      ctx.strokeStyle =
        activeRegionId !== null ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.3)'
      ctx.lineWidth = dpr
      ctx.beginPath()
      ctx.ellipse(bx, by, brushRadius * sx * fit.scale, brushRadius * sy * fit.scale, 0, 0, 7)
      ctx.stroke()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    volume,
    plane,
    cross,
    fit,
    size,
    segBox,
    segTool,
    brushHover,
    brushRadius,
    activeRegionId,
    view
  ])

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
    const st = useStore.getState()
    const pt = pendingPointRef.current
    if (pt) {
      pendingPointRef.current = null
      const next: [number, number, number] = [...st.cross]
      next[plane.colAxis] = pt[0]
      next[plane.rowAxis] = pt[1]
      st.setCross(next)
    }
    const box = pendingBoxRef.current
    if (box) {
      pendingBoxRef.current = null
      st.setSegBox(box)
    }
  }

  const scheduleFlush = (): void => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(commitPoint)
  }

  const hitHandle = (
    px: number,
    py: number
  ): { editCol: 'min' | 'max' | null; editRow: 'min' | 'max' | null } | null => {
    // No handles on slices the box doesn't cut (they aren't drawn there).
    if (!segBox || !fit || !sliceCutsBox(segBox)) return null
    const r = boxRect(segBox)
    const dpr = window.devicePixelRatio || 1
    const tol = HANDLE_HIT_PX * dpr
    const mx = (r.x0 + r.x1) / 2
    const my = (r.y0 + r.y1) / 2
    // Screen-y0 is the top edge, which is the row-axis *max* side.
    const handles: {
      x: number
      y: number
      editCol: 'min' | 'max' | null
      editRow: 'min' | 'max' | null
    }[] = [
      { x: r.x0, y: r.y0, editCol: 'min', editRow: 'max' },
      { x: r.x1, y: r.y0, editCol: 'max', editRow: 'max' },
      { x: r.x0, y: r.y1, editCol: 'min', editRow: 'min' },
      { x: r.x1, y: r.y1, editCol: 'max', editRow: 'min' },
      { x: mx, y: r.y0, editCol: null, editRow: 'max' },
      { x: mx, y: r.y1, editCol: null, editRow: 'min' },
      { x: r.x0, y: my, editCol: 'min', editRow: null },
      { x: r.x1, y: my, editCol: 'max', editRow: null }
    ]
    for (const hnd of handles) {
      if (Math.abs(px - hnd.x) <= tol && Math.abs(py - hnd.y) <= tol) {
        return { editCol: hnd.editCol, editRow: hnd.editRow }
      }
    }
    return null
  }

  /** Resize cursor matching a handle's direction. Screen-y0 is the row-axis
   * max side, so {min col, max row} is the top-left corner. */
  const cursorForHandle = (h: {
    editCol: 'min' | 'max' | null
    editRow: 'min' | 'max' | null
  }): string => {
    if (h.editCol && h.editRow) {
      const topLeft = h.editCol === 'min' && h.editRow === 'max'
      const bottomRight = h.editCol === 'max' && h.editRow === 'min'
      return topLeft || bottomRight ? 'nwse-resize' : 'nesw-resize'
    }
    return h.editCol ? 'ew-resize' : 'ns-resize'
  }

  /** Inline cursor on the overlay canvas ('' falls back to the tool's CSS). */
  const setCursor = (cursor: string): void => {
    const el = overlayRef.current
    if (el && el.style.cursor !== cursor) el.style.cursor = cursor
  }

  const canvasPx = (clientX: number, clientY: number): [number, number] => {
    const el = containerRef.current as HTMLDivElement
    const dpr = window.devicePixelRatio || 1
    const rect = el.getBoundingClientRect()
    return [(clientX - rect.left) * dpr, (clientY - rect.top) * dpr]
  }

  const cloneBox = (b: SegBox): SegBox => ({ min: [...b.min], max: [...b.max] })

  const resolveBoxDrag = (drag: BoxDrag, vox: [number, number]): SegBox => {
    const box = cloneBox(drag.startBox)
    const ca = plane.colAxis
    const ra = plane.rowAxis
    if (drag.kind === 'create') {
      box.min[ca] = Math.min(drag.anchor[0], vox[0])
      box.max[ca] = Math.max(drag.anchor[0], vox[0])
      box.min[ra] = Math.min(drag.anchor[1], vox[1])
      box.max[ra] = Math.max(drag.anchor[1], vox[1])
    } else if (drag.kind === 'move') {
      const vol = volume as NonNullable<typeof volume>
      const dc = Math.min(
        Math.max(vox[0] - drag.anchor[0], -drag.startBox.min[ca]),
        vol.dims[ca] - 1 - drag.startBox.max[ca]
      )
      const dr = Math.min(
        Math.max(vox[1] - drag.anchor[1], -drag.startBox.min[ra]),
        vol.dims[ra] - 1 - drag.startBox.max[ra]
      )
      box.min[ca] += dc
      box.max[ca] += dc
      box.min[ra] += dr
      box.max[ra] += dr
    } else {
      // setSegBox sorts per axis, so dragging an edge across its opposite
      // simply flips which side follows the pointer.
      if (drag.editCol) box[drag.editCol][ca] = vox[0]
      if (drag.editRow) box[drag.editRow][ra] = vox[1]
    }
    return box
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (!volume || !fit) return
    const st = useStore.getState()

    if (segTool === 'brush') {
      if (e.button !== 0 && e.button !== 2) return
      const vox = pixelToVoxel(e.clientX, e.clientY)
      if (!vox || st.activeRegionId === null) return
      const erase = e.button === 2 || e.altKey
      paintingRef.current = { last: vox, erase }
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      st.paintAt(view, vox, vox, erase)
      return
    }

    // Navigate mode: right-clicking a committed region re-opens it for
    // segmentation editing (box + parameters restored from its commit).
    if (segTool === 'crosshair' && e.button === 2) {
      const vox = pixelToVoxel(e.clientX, e.clientY)
      if (!vox || !st.labelMap) return
      const st3 = strides(volume.dims)
      const id =
        st.labelMap[
          vox[0] * st3[plane.colAxis] +
            vox[1] * st3[plane.rowAxis] +
            sliceIdx * st3[plane.sliceAxis]
        ]
      if (id !== 0) st.editRegion(id)
      return
    }

    if (e.button !== 0) return

    if (segTool === 'box') {
      const vox = pixelToVoxelClamped(e.clientX, e.clientY)
      if (!vox) return
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      const [px, py] = canvasPx(e.clientX, e.clientY)
      const handle = segBox ? hitHandle(px, py) : null
      if (segBox && handle) {
        // Keep the resize cursor for the whole drag, even when the pointer
        // races ahead of the handle.
        setCursor(cursorForHandle(handle))
        boxDragRef.current = {
          kind: 'resize',
          anchor: vox,
          startBox: cloneBox(segBox),
          ...handle,
          moved: false
        }
      } else if (
        segBox &&
        sliceCutsBox(segBox) &&
        vox[0] >= segBox.min[plane.colAxis] &&
        vox[0] <= segBox.max[plane.colAxis] &&
        vox[1] >= segBox.min[plane.rowAxis] &&
        vox[1] <= segBox.max[plane.rowAxis]
      ) {
        boxDragRef.current = {
          kind: 'move',
          anchor: vox,
          startBox: cloneBox(segBox),
          editCol: null,
          editRow: null,
          moved: false
        }
      } else {
        const start: SegBox = { min: [0, 0, 0], max: [0, 0, 0] }
        start.min[plane.colAxis] = vox[0]
        start.max[plane.colAxis] = vox[0]
        start.min[plane.rowAxis] = vox[1]
        start.max[plane.rowAxis] = vox[1]
        start.min[plane.sliceAxis] = sliceIdx
        start.max[plane.sliceAxis] = sliceIdx
        boxDragRef.current = {
          kind: 'create',
          anchor: vox,
          startBox: start,
          editCol: null,
          editRow: null,
          moved: false
        }
        st.setSegBox(start)
      }
      return
    }

    const vox = pixelToVoxel(e.clientX, e.clientY)
    if (!vox) return
    draggingRef.current = true
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const next: [number, number, number] = [...st.cross]
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

    if (paintingRef.current) {
      if (!vox) return
      const p = paintingRef.current
      useStore.getState().paintAt(view, p.last, vox, p.erase)
      p.last = vox
      return
    }

    const boxDrag = boxDragRef.current
    if (boxDrag) {
      const cvox = pixelToVoxelClamped(e.clientX, e.clientY)
      if (!cvox) return
      if (cvox[0] !== boxDrag.anchor[0] || cvox[1] !== boxDrag.anchor[1]) boxDrag.moved = true
      pendingBoxRef.current = resolveBoxDrag(boxDrag, cvox)
      scheduleFlush()
      return
    }

    // Hover feedback for the box tool: resize arrows over the handles, a
    // move cursor inside the box, the drawing cursor elsewhere.
    if (segTool === 'box' && fit) {
      const [px, py] = canvasPx(e.clientX, e.clientY)
      const handle = hitHandle(px, py)
      if (handle) {
        setCursor(cursorForHandle(handle))
      } else if (
        segBox &&
        sliceCutsBox(segBox) &&
        vox &&
        vox[0] >= segBox.min[plane.colAxis] &&
        vox[0] <= segBox.max[plane.colAxis] &&
        vox[1] >= segBox.min[plane.rowAxis] &&
        vox[1] <= segBox.max[plane.rowAxis]
      ) {
        setCursor('move')
      } else {
        setCursor('')
      }
    }

    if (!draggingRef.current) return
    if (!vox) return
    pendingPointRef.current = vox
    scheduleFlush()
  }

  // On pointercancel the browser already released the capture; releasing
  // again throws, and the gesture teardown below must still run.
  const releaseCapture = (e: React.PointerEvent): void => {
    try {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // Already released.
    }
  }

  /** Shared by pointerup and pointercancel: a cancelled gesture (system
   * gesture, capture loss) must still end the stroke/drag, or the module-
   * level collector would leak stamps into the next gesture. */
  const onPointerUp = (e: React.PointerEvent): void => {
    if (draggingRef.current) {
      draggingRef.current = false
      releaseCapture(e)
    }
    if (paintingRef.current) {
      paintingRef.current = null
      releaseCapture(e)
      useStore.getState().endStroke()
    }
    const boxDrag = boxDragRef.current
    if (boxDrag) {
      boxDragRef.current = null
      releaseCapture(e)
      // Flush any pending rAF update so the final geometry is applied.
      commitPoint()
      const st = useStore.getState()
      if (boxDrag.kind === 'create') {
        if (!boxDrag.moved || !st.segBox) {
          // A click without a drag is not a box.
          st.setSegBox(null)
          return
        }
        // The in-plane rect comes from the drag; the through-plane (slab)
        // extent is the slab-depth setting centered on the current slice.
        const box = cloneBox(st.segBox)
        const half = Math.floor(Math.max(1, st.slabDepth) / 2)
        box.min[plane.sliceAxis] = sliceIdx - half
        box.max[plane.sliceAxis] = sliceIdx + half
        st.finalizeBox(box, plane.sliceAxis)
      }
    }
  }

  const onPointerLeave = (): void => {
    setHover(null)
    setCursor('')
  }

  // Tool switches drop any lingering inline cursor back to the tool's CSS one.
  useEffect(() => {
    const el = overlayRef.current
    if (el) el.style.cursor = ''
  }, [segTool])

  // Double-click in navigate mode toggles maximizing this view over the
  // workspace; every tool keeps working inside the maximized view.
  const onDoubleClick = (): void => {
    if (segTool === 'crosshair') useStore.getState().toggleMaximized(view)
  }

  const axisName = AXIS_NAMES[plane.sliceAxis]
  const maxSlice = volume ? volume.dims[plane.sliceAxis] - 1 : 0
  const cursorClass = segTool === 'box' ? ' box-tool' : segTool === 'brush' ? ' brush-tool' : ''

  return (
    <div
      ref={containerRef}
      className={`slice-view${hoveredView === view ? ' hovered' : ''}${cursorClass}${maximized ? ' view-max' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
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
