import { useState, type JSX } from 'react'
import { useStore } from '../store'
import { RangeSlider } from './RangeSlider'
import { fmt } from '../format'
import {
  labelColorCSS,
  labelInventory,
  overlayVoxelToBase,
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

function EyeIcon({ off }: { off: boolean }): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
        <path d="M1.8 8C3.6 4.9 12.4 4.9 14.2 8C12.4 11.1 3.6 11.1 1.8 8Z" />
        <circle cx="8" cy="8" r="1.9" />
        {off && <line x1="3" y1="13.2" x2="13" y2="2.8" />}
      </g>
    </svg>
  )
}

/**
 * Collapsible label list for the labels kind: color swatch, id + name
 * (click = jump the crosshair to that label), voxel count, and an eye toggle
 * for per-label visibility. Collapsed by default — real label volumes can
 * carry hundreds of entries, so the list (and the inventory scan) only
 * happens on expand.
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
  const base = useStore((s) => s.volume)
  const setCross = useStore((s) => s.setCross)

  const hidden = layer.hiddenLabels
  const entries = open ? labelInventory(layer.volume) : null
  const names = layer.volume.labels
  const q = filter.trim().toLowerCase()
  const shown = entries?.filter(
    (e) => !q || String(e.id).includes(q) || (names?.get(e.id) ?? '').toLowerCase().includes(q)
  )

  const toggle = (id: number): void => {
    const next = new Set(hidden)
    if (!next.delete(id)) next.add(id)
    onPatch({ hiddenLabels: next })
  }

  const jumpTo = (id: number, pos: [number, number, number]): void => {
    if (!base) return
    const target = overlayVoxelToBase(base, layer.volume, pos)
    if (!target) return
    setCross(target)
    // Jumping to a label implies wanting to see it.
    if (hidden.has(id)) toggle(id)
  }

  return (
    <div className="label-visibility">
      <button className="preset-btn expander" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Labels
        {entries ? ` · ${entries.length}` : ''}
        {hidden.size > 0 ? ` · ${hidden.size} hidden` : ''}
      </button>
      {open && entries && shown && (
        <>
          <div className="preset-row">
            <button className="preset-btn" onClick={() => onPatch({ hiddenLabels: new Set() })}>
              All
            </button>
            <button
              className="preset-btn"
              onClick={() => onPatch({ hiddenLabels: new Set(entries.map((e) => e.id)) })}
            >
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
            {shown.map(({ id, count, pos }) => {
              const off = hidden.has(id)
              const name = names?.get(id)
              return (
                <div key={id} className={`label-row${off ? ' off' : ''}`}>
                  <span className="swatch" style={{ background: labelColorCSS(id) }} />
                  <button
                    className="label-jump"
                    disabled={!pos}
                    title={pos ? 'Jump to this label' : 'Not present in the data'}
                    onClick={() => pos && jumpTo(id, pos)}
                  >
                    <span className="id-chip mono">{id}</span>
                    <span className="label-name">{name ?? `label ${id}`}</span>
                  </button>
                  <span className="count mono">{count.toLocaleString('en-US')}</span>
                  <button
                    className="eye-btn"
                    title={off ? 'Show label' : 'Hide label'}
                    aria-pressed={!off}
                    onClick={() => toggle(id)}
                  >
                    <EyeIcon off={off} />
                  </button>
                </div>
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
                className="eye-btn"
                title={layer.visible ? 'Hide layer' : 'Show layer'}
                aria-pressed={layer.visible}
                onClick={() => updateOverlay(layer.id, { visible: !layer.visible })}
              >
                <EyeIcon off={!layer.visible} />
              </button>
              <span
                className="layer-name"
                title={layer.volume.name}
                style={layer.visible ? undefined : { opacity: 0.38 }}
              >
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
