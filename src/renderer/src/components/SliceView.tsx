import { useEffect, useMemo, useRef, type JSX } from 'react'
import { useStore } from '../store'
import { PLANES } from '../slicing/extract'
import { slicePlanesForAffine } from '../slicing/directionLabels'
import { drawSliceAnnotations } from '../slicing/drawAnnotations'
import { SliceRasterRenderer } from '../slicing/sliceRasterRenderer'
import { sharedSliceFitSize } from '../slicing/viewport'
import { useSliceGestures } from './useSliceGestures'
import { useSliceViewport } from './useSliceViewport'

interface Props {
  view: 0 | 1 | 2
}

export function SliceView({ view }: Props): JSX.Element {
  const volume = useStore((state) => state.volume)
  const planes = useMemo(() => (volume ? slicePlanesForAffine(volume.affine) : PLANES), [volume])
  const plane = planes[view]
  const sliceIndex = useStore((state) => state.cross[plane.sliceAxis])
  const cross = useStore((state) => state.cross)
  const frame = useStore((state) => state.frame)
  const range = useStore((state) => state.range)
  const baseColormap = useStore((state) => state.baseColormap)
  const overlays = useStore((state) => state.overlays)
  const hoveredView = useStore((state) => state.hover?.view)
  const segTool = useStore((state) => state.segTool)
  const brushHover = useStore((state) =>
    state.segTool === 'brush' && state.hover?.view === view ? state.hover : null
  )
  const segBox = useStore((state) => state.segBox)
  const preview = useStore((state) => state.preview)
  const modelPreview = useStore((state) => state.modelRun.preview)
  const labelMap = useStore((state) => state.labelMap)
  const labelMapRevision = useStore((state) => state.labelMapRev)
  const regions = useStore((state) => state.regions)
  const regionOpacity = useStore((state) => state.regionOpacity)
  const nextRegionId = useStore((state) => state.nextRegionId)
  const brushRadius = useStore((state) => state.brushRadius)
  const activeRegionId = useStore((state) => state.activeRegionId)
  const editRegionId = useStore((state) => state.editRegionId)
  const maximized = useStore((state) => state.maximizedView === view)
  const directionLabelsVisible = useStore((state) => state.directionLabelsVisible)
  const crosshairVisible = useStore((state) => state.crosshairVisible)

  const containerRef = useRef<HTMLDivElement>(null)
  const baseRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const rasterRendererRef = useRef<SliceRasterRenderer | null>(null)

  const columns = volume ? volume.dims[plane.colAxis] : 0
  const rows = volume ? volume.dims[plane.rowAxis] : 0
  const columnSpacing = volume ? volume.spacing[plane.colAxis] : 1
  const rowSpacing = volume ? volume.spacing[plane.rowAxis] : 1
  const sharedFit = useMemo(
    () => (volume && !maximized ? sharedSliceFitSize(volume.dims, volume.spacing, planes) : null),
    [volume, maximized, planes]
  )
  const { canvasSize, devicePixelRatio, viewport } = useSliceViewport(
    containerRef,
    columns,
    rows,
    columnSpacing,
    rowSpacing,
    sharedFit
  )

  const gestures = useSliceGestures({
    view,
    plane,
    volume,
    viewport,
    devicePixelRatio,
    segTool,
    containerRef,
    overlayRef
  })

  // The renderer instance owns every raster cache for this mounted view.
  // Constructing it in the effect keeps StrictMode's setup/cleanup replay safe.
  useEffect(() => {
    const renderer = new SliceRasterRenderer()
    rasterRendererRef.current = renderer
    return () => {
      if (rasterRendererRef.current === renderer) rasterRendererRef.current = null
      renderer.dispose()
    }
  }, [])

  useEffect(() => {
    const canvas = baseRef.current
    const renderer = rasterRendererRef.current
    if (!canvas || !renderer || !volume || !viewport) return
    renderer.render({
      canvas,
      canvasSize,
      fit: viewport.fit,
      volume,
      plane,
      sliceIndex,
      frame,
      range,
      baseColormap,
      overlays,
      labelMap,
      labelMapRevision,
      regions,
      regionOpacity,
      preview,
      modelPreview,
      nextRegionId,
      editRegionId
    })
  }, [
    volume,
    plane,
    sliceIndex,
    frame,
    range,
    baseColormap,
    overlays,
    viewport,
    canvasSize,
    labelMap,
    labelMapRevision,
    regions,
    regionOpacity,
    preview,
    modelPreview,
    nextRegionId,
    editRegionId
  ])

  useEffect(() => {
    const canvas = overlayRef.current
    if (!canvas || !volume || !viewport) return
    if (canvas.width !== canvasSize[0] || canvas.height !== canvasSize[1]) {
      canvas.width = canvasSize[0]
      canvas.height = canvasSize[1]
    }
    const context = canvas.getContext('2d')
    if (!context) return
    drawSliceAnnotations(context, {
      canvasSize,
      viewport,
      plane,
      sliceIndex,
      cross,
      segBox,
      segTool,
      brushHover,
      brushRadius,
      activeRegionId,
      affine: volume.affine,
      directionLabelsVisible,
      crosshairVisible,
      devicePixelRatio
    })
  }, [
    volume,
    viewport,
    canvasSize,
    plane,
    sliceIndex,
    cross,
    segBox,
    segTool,
    brushHover,
    brushRadius,
    activeRegionId,
    directionLabelsVisible,
    crosshairVisible,
    devicePixelRatio
  ])

  const maxSlice = volume ? volume.dims[plane.sliceAxis] - 1 : 0
  const cursorClass = segTool === 'box' ? ' box-tool' : segTool === 'brush' ? ' brush-tool' : ''

  return (
    <div
      ref={containerRef}
      className={`slice-view${hoveredView === view ? ' hovered' : ''}${cursorClass}${maximized ? ' view-max' : ''}`}
      onPointerDown={gestures.onPointerDown}
      onPointerMove={gestures.onPointerMove}
      onPointerUp={gestures.onPointerUp}
      onPointerCancel={gestures.onPointerCancel}
      onLostPointerCapture={gestures.onLostPointerCapture}
      onPointerLeave={gestures.onPointerLeave}
      onDoubleClick={gestures.onDoubleClick}
      onContextMenu={(event) => event.preventDefault()}
    >
      <canvas ref={baseRef} />
      <canvas ref={overlayRef} className="overlay-canvas" />
      <div className="chip">
        <span className="plane-name">{plane.label}</span>
        <span className="mono">
          axis {plane.sliceAxis} {sliceIndex}/{maxSlice}
        </span>
      </div>
    </div>
  )
}
