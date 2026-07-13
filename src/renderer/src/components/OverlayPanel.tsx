import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { useStore } from '../store'
import { RangeSlider } from './RangeSlider'
import { EyeIcon } from './EyeIcon'
import { CollapsibleSection } from './CollapsibleSection'
import { CorrectionControls } from './CorrectionControls'
import { fmt } from '../format'
import {
  layerLabelColorCSS,
  layerLabelName,
  labelInventory,
  MAX_LISTED_LABELS,
  overlayVoxelToBase,
  type ColormapName,
  type LayerTableSource,
  type OverlayKind,
  type OverlayLayer
} from '../slicing/overlay'

const TABLE_SOURCE_LABEL: Record<LayerTableSource, string> = {
  automatic: 'Automatic colors',
  'built-in': 'Built-in',
  matching: 'Matching file',
  custom: 'Custom'
}

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
 * Collapsible label list for the labels kind: color swatch, id + name
 * (click = jump the crosshair to that label), voxel count, and an eye toggle
 * for per-label visibility. Whether a new layer starts open follows the
 * `expandLabelLists` application setting (default on); the inventory scan is
 * memoized per volume, so opening by default costs one pass per label volume.
 */
function LabelVisibility({
  layer,
  onPatch
}: {
  layer: OverlayLayer
  onPatch: (patch: { hiddenLabels: Set<number> }) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  // Default-open is deferred to idle time so the first (whole-volume)
  // inventory pass never rides the load path's commit render. The setting is
  // read once per mount — a change affects layers added afterwards — and an
  // explicit user toggle before the idle callback wins.
  const interacted = useRef(false)
  useEffect(() => {
    if (!useStore.getState().expandLabelLists) return
    const reveal = (): void => {
      if (!interacted.current) setOpen(true)
    }
    if (typeof requestIdleCallback === 'function') {
      const handle = requestIdleCallback(reveal)
      return () => cancelIdleCallback(handle)
    }
    const handle = window.setTimeout(reveal, 0)
    return () => window.clearTimeout(handle)
  }, [])
  const [filter, setFilter] = useState('')
  const base = useStore((s) => s.volume)
  const setCross = useStore((s) => s.setCross)

  const hidden = layer.hiddenLabels
  const entries = open
    ? (() => {
        const inventory = labelInventory(layer.volume)
        if (!layer.labelTable) return inventory
        const seen = new Set(inventory.map((entry) => entry.id))
        return [
          ...inventory,
          ...[...layer.labelTable.keys()]
            .filter((id) => !seen.has(id))
            .sort((a, b) => a - b)
            .slice(0, Math.max(0, MAX_LISTED_LABELS - inventory.length))
            .map((id) => ({ id, count: 0, pos: null }))
        ]
      })()
    : null
  const q = filter.trim().toLowerCase()
  const shown = entries?.filter(
    (e) =>
      !q ||
      String(e.id).includes(q) ||
      (layerLabelName(layer, e.id) ?? '').toLowerCase().includes(q)
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

  const badge = [
    entries ? `${entries.length}` : null,
    hidden.size > 0 ? `${hidden.size} hidden` : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="label-visibility">
      {/* Controlled with local state: layer ids are session-scoped, so this
          collapse is deliberately not persisted. */}
      <CollapsibleSection
        title="Labels"
        badge={badge || undefined}
        open={open}
        onToggle={(next) => {
          interacted.current = true
          setOpen(next)
        }}
      >
        {entries && shown && (
          <>
            <div className="preset-row" style={{ marginTop: 0 }}>
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
                onKeyDown={(e) => {
                  // Esc clears the filter instead of bubbling to app shortcuts.
                  if (e.key === 'Escape' && filter !== '') {
                    e.stopPropagation()
                    setFilter('')
                  }
                }}
              />
            </div>
            <div className="label-list">
              {shown.map(({ id, count, pos }) => {
                const off = hidden.has(id)
                const name = layerLabelName(layer, id)
                return (
                  <div key={id} className={`label-row${off ? ' off' : ''}`}>
                    <span
                      className="swatch"
                      style={{ background: layerLabelColorCSS(layer, id) }}
                    />
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
              {shown.length === 0 && (
                <div className="label-empty mono">
                  {entries.length === 0 ? 'no labels in the data' : 'no match'}
                </div>
              )}
            </div>
          </>
        )}
      </CollapsibleSection>
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

function LayerTableMenu({
  layer,
  onChoose,
  onUseBuiltIn,
  onSelectSource
}: {
  layer: OverlayLayer
  onChoose: () => void
  onUseBuiltIn: () => void
  onSelectSource: (source: LayerTableSource) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const activeOption =
    layer.labelTableSource === 'matching'
      ? layer.matchingTable
      : layer.labelTableSource === 'built-in'
        ? layer.builtInTable
        : layer.labelTableSource === 'custom'
          ? layer.customTable
          : null
  const currentLabel = activeOption
    ? `${TABLE_SOURCE_LABEL[layer.labelTableSource]} · ${activeOption.name}`
    : TABLE_SOURCE_LABEL[layer.labelTableSource]

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  const chooseSource = (source: LayerTableSource): void => {
    if (source === 'built-in' && !layer.builtInTable) onUseBuiltIn()
    else onSelectSource(source)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const options: Array<{ source: LayerTableSource; label: string }> = [
    { source: 'automatic', label: 'Automatic colors' },
    { source: 'built-in', label: `Built-in · ${layer.builtInTable?.name ?? 'FreeSurfer'}` },
    ...(layer.matchingTable
      ? [{ source: 'matching' as const, label: `Matching file · ${layer.matchingTable.name}` }]
      : []),
    ...(layer.customTable
      ? [{ source: 'custom' as const, label: `Custom · ${layer.customTable.name}` }]
      : [])
  ]

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null)
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1 + items.length) % items.length
            : (current - 1 + items.length) % items.length
    items[next].focus()
  }

  return (
    <div
      className="table-picker"
      ref={rootRef}
      onBlur={(event) => {
        if (
          open &&
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          setOpen(false)
        }
      }}
    >
      <span className="table-picker-label">Color table</span>
      <button
        ref={triggerRef}
        className="table-picker-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={currentLabel}
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) {
            requestAnimationFrame(() => {
              const selected = options.findIndex(
                (option) => option.source === layer.labelTableSource
              )
              itemRefs.current[Math.max(0, selected)]?.focus()
            })
          }
        }}
      >
        <span>{currentLabel}</span>
        <span className="table-picker-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="table-picker-menu" role="menu" onKeyDown={onMenuKeyDown}>
          {options.map((option, index) => (
            <button
              key={option.source}
              ref={(element) => {
                itemRefs.current[index] = element
              }}
              type="button"
              role="menuitemradio"
              aria-checked={layer.labelTableSource === option.source}
              title={option.label}
              onClick={() => chooseSource(option.source)}
            >
              <span className="table-picker-check" aria-hidden="true">
                {layer.labelTableSource === option.source ? '✓' : ''}
              </span>
              <span>{option.label}</span>
            </button>
          ))}
          <div className="table-picker-separator" role="separator" />
          <button
            ref={(element) => {
              itemRefs.current[options.length] = element
            }}
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              triggerRef.current?.focus()
              onChoose()
            }}
          >
            <span className="table-picker-check" aria-hidden="true">
              +
            </span>
            <span>Choose .txt…</span>
          </button>
        </div>
      )}
    </div>
  )
}

export function OverlayPanel({
  onAdd,
  onChooseTable,
  onUseBuiltInTable,
  onSelectTableSource,
  onExportCorrection
}: {
  onAdd: () => void
  onChooseTable: (id: number) => void
  onUseBuiltInTable: (id: number) => void
  onSelectTableSource: (id: number, source: LayerTableSource) => void
  onExportCorrection: (layer: OverlayLayer) => void
}): JSX.Element | null {
  const volume = useStore((s) => s.volume)
  const overlays = useStore((s) => s.overlays)
  const updateOverlay = useStore((s) => s.updateOverlay)
  const removeOverlay = useStore((s) => s.removeOverlay)

  if (!volume) return null

  return (
    <div className="panel-section">
      <div className="tab-toolbar">
        <button
          className="preset-btn"
          title={
            navigator.platform.toLowerCase().includes('mac')
              ? 'Add layer (⌘A)'
              : 'Add layer (Ctrl+A)'
          }
          onClick={onAdd}
        >
          Add layer
        </button>
      </div>
      {overlays.length === 0 && (
        <div className="seg-hint">
          No layers yet — click Add layer, or drop a file onto the views.
        </div>
      )}
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
              {layer.labelTable || layer.volume.labels
                ? ` · ${layer.labelTable?.size ?? layer.volume.labels?.size ?? 0} names`
                : ''}
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
              <>
                <LayerTableMenu
                  layer={layer}
                  onChoose={() => onChooseTable(layer.id)}
                  onUseBuiltIn={() => onUseBuiltInTable(layer.id)}
                  onSelectSource={(source) => onSelectTableSource(layer.id, source)}
                />
                <LabelVisibility
                  layer={layer}
                  onPatch={(patch) => updateOverlay(layer.id, patch)}
                />
              </>
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
                <CorrectionControls
                  layer={layer}
                  onPatch={(patch) => updateOverlay(layer.id, patch)}
                  onExport={() => onExportCorrection(layer)}
                />
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
