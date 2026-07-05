import { useState, type JSX } from 'react'
import { useStore } from '../store'
import { RangeSlider } from './RangeSlider'
import { fmt } from '../format'
import {
  labelColorCSS,
  listLabelIds,
  type ColormapName,
  type OverlayKind,
  type OverlayLayer
} from '../slicing/overlay'

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

/**
 * Collapsible per-label visibility list for the labels kind. Collapsed by
 * default — real label volumes can carry hundreds of entries, so the list
 * (and the id scan for volumes without a name table) only happens on expand.
 */
function LabelVisibility({
  layer,
  onPatch
}: {
  layer: OverlayLayer
  onPatch: (patch: { hiddenLabels: Set<number> }) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')

  const hidden = layer.hiddenLabels
  const ids = open ? listLabelIds(layer.volume) : null
  const names = layer.volume.labels
  const q = filter.trim().toLowerCase()
  const shown = ids?.filter(
    (id) => !q || String(id).includes(q) || (names?.get(id) ?? '').toLowerCase().includes(q)
  )

  const toggle = (id: number): void => {
    const next = new Set(hidden)
    if (!next.delete(id)) next.add(id)
    onPatch({ hiddenLabels: next })
  }

  return (
    <div className="label-visibility">
      <button className="preset-btn expander" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Label visibility
        {hidden.size > 0 ? ` · ${hidden.size} hidden` : ''}
      </button>
      {open && ids && shown && (
        <>
          <div className="preset-row">
            <button className="preset-btn" onClick={() => onPatch({ hiddenLabels: new Set() })}>
              All
            </button>
            <button className="preset-btn" onClick={() => onPatch({ hiddenLabels: new Set(ids) })}>
              None
            </button>
            <input
              className="label-filter mono"
              type="text"
              placeholder="filter…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="label-list">
            {shown.map((id) => {
              const off = hidden.has(id)
              return (
                <button
                  key={id}
                  className={`label-row${off ? ' off' : ''}`}
                  onClick={() => toggle(id)}
                >
                  <span className="swatch" style={{ background: labelColorCSS(id) }} />
                  <span className="label-name">{names?.get(id) ?? `id ${id}`}</span>
                  <span className="tick">{off ? '' : '✓'}</span>
                </button>
              )
            })}
            {shown.length === 0 && <div className="label-empty mono">no match</div>}
          </div>
        </>
      )}
    </div>
  )
}

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
            <div className="mono layer-dims">
              {layer.volume.dims.join(' × ')}
              {layer.volume.labels ? ` · ${layer.volume.labels.size} names` : ''}
            </div>
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
            {layer.kind === 'labels' && (
              <LabelVisibility layer={layer} onPatch={(patch) => updateOverlay(layer.id, patch)} />
            )}
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
