import { type JSX } from 'react'
import { useStore } from '../store'
import { RangeSlider } from './RangeSlider'
import { fmt } from '../format'
import type { ColormapName, OverlayKind, OverlayLayer } from '../slicing/overlay'

const KINDS: { key: OverlayKind; label: string }[] = [
  { key: 'map', label: 'Map' },
  { key: 'mask', label: 'Mask' },
  { key: 'labels', label: 'Labels' }
]

const COLORMAPS: { key: ColormapName; label: string }[] = [
  { key: 'warm', label: 'Warm' },
  { key: 'cool', label: 'Cool' },
  { key: 'signed', label: 'Signed' }
]

function mapDomain(layer: OverlayLayer): { min: number; max: number } {
  const { stats } = layer.volume
  if (layer.colormap === 'signed') {
    return { min: 0, max: Math.max(Math.abs(stats.dataMin), stats.dataMax, layer.range.hi) }
  }
  return {
    min: Math.min(stats.dataMin, layer.range.lo, 0),
    max: Math.max(stats.dataMax, layer.range.hi)
  }
}

export function OverlayPanel({ onAdd }: { onAdd: () => void }): JSX.Element | null {
  const volume = useStore((s) => s.volume)
  const overlays = useStore((s) => s.overlays)
  const updateOverlay = useStore((s) => s.updateOverlay)
  const removeOverlay = useStore((s) => s.removeOverlay)

  if (!volume) return null

  return (
    <div className="panel-section">
      <div className="layer-head">
        <h3>Overlays</h3>
        <button className="preset-btn" onClick={onAdd}>
          Add layer
        </button>
      </div>
      {overlays.map((layer) => {
        const domain = mapDomain(layer)
        return (
          <div className="overlay-row" key={layer.id}>
            <div className="layer-head">
              <button
                className={`preset-btn${layer.visible ? ' active' : ''}`}
                aria-pressed={layer.visible}
                onClick={() => updateOverlay(layer.id, { visible: !layer.visible })}
              >
                {layer.visible ? 'On' : 'Off'}
              </button>
              <span className="layer-name" title={layer.volume.name}>
                {layer.volume.name}
              </span>
              <button
                className="preset-btn"
                aria-label="Remove layer"
                onClick={() => removeOverlay(layer.id)}
              >
                ✕
              </button>
            </div>
            <div className="mono layer-dims">{layer.volume.dims.join(' × ')}</div>
            <div className="preset-row">
              {KINDS.map((k) => (
                <button
                  key={k.key}
                  className={`preset-btn${layer.kind === k.key ? ' active' : ''}`}
                  onClick={() => updateOverlay(layer.id, { kind: k.key })}
                >
                  {k.label}
                </button>
              ))}
            </div>
            <div className="frame-slider">
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={layer.opacity}
                onChange={(e) => updateOverlay(layer.id, { opacity: Number(e.target.value) })}
              />
              <span className="frame-label mono">op {layer.opacity.toFixed(2)}</span>
            </div>
            {layer.kind === 'map' && (
              <>
                <div className="preset-row">
                  {COLORMAPS.map((c) => (
                    <button
                      key={c.key}
                      className={`preset-btn${layer.colormap === c.key ? ' active' : ''}`}
                      onClick={() => updateOverlay(layer.id, { colormap: c.key })}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <RangeSlider
                  min={domain.min}
                  max={domain.max}
                  lo={layer.range.lo}
                  hi={layer.range.hi}
                  onChange={(lo, hi) => updateOverlay(layer.id, { range: { lo, hi } })}
                />
                <div className="range-readout mono">
                  <span>{fmt(layer.range.lo)}</span>
                  <span>{fmt(layer.range.hi)}</span>
                </div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
