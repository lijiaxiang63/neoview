import type { JSX } from 'react'
import { useStore } from '../store'
import { useVolumeRenderer } from './useVolumeRenderer'

export function VolumeView(): JSX.Element {
  const volume = useStore((state) => state.volume)
  const frame = useStore((state) => state.frame)
  const range = useStore((state) => state.range)
  const renderMode = useStore((state) => state.renderMode)
  const density = useStore((state) => state.density)
  const brightness = useStore((state) => state.brightness)
  const labelMap = useStore((state) => state.labelMap)
  const labelMapRev = useStore((state) => state.labelMapRev)
  const regions = useStore((state) => state.regions)
  const regionOpacity = useStore((state) => state.regionOpacity)
  const { containerRef, canvasRef, unsupported, dragging, handlers } = useVolumeRenderer({
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

  return (
    <div
      ref={containerRef}
      className={`volume-view${dragging ? ' dragging' : ''}`}
      onPointerDown={handlers.onPointerDown}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      onPointerCancel={handlers.onPointerCancel}
      onLostPointerCapture={handlers.onLostPointerCapture}
      onDoubleClick={handlers.onDoubleClick}
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
