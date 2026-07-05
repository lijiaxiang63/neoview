import { useEffect, useRef, useState, type JSX } from 'react'
import {
  BRUSH_RADIUS_MAX,
  BRUSH_RADIUS_MIN,
  useStore,
  type SegConstraint,
  type SegTool
} from '../store'
import { fmt } from '../format'
import {
  buildLabelMapExport,
  buildMaskExport,
  loadExportSettings,
  saveExportSettings,
  type ExportSettings
} from '../segmentation/exportRegions'
import {
  boxExtent,
  GROW_BOUNDARY_RANGE,
  GROW_SEED_RANGE,
  THRESHOLD_RANGE,
  type HistogramResult,
  type SegBox
} from '../segmentation/segment'
import type { Region } from '../segmentation/regions'

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

const TOOLS: { key: SegTool; label: string; title: string }[] = [
  {
    key: 'crosshair',
    label: 'Navigate',
    title:
      'Click and drag to move the crosshair; right-click a region to re-segment it; double-click maximizes the view'
  },
  {
    key: 'box',
    label: 'Box',
    title: 'Drag on a slice view to define a box; drag handles to resize'
  },
  {
    key: 'brush',
    label: 'Brush',
    title: 'Paint voxels into the selected region; Alt or right-drag erases'
  }
]

function constraintKey(c: SegConstraint): string {
  if (c.type === 'overlay') return `overlay:${c.overlayId}`
  if (c.type === 'region') return `region:${c.regionId}`
  return 'none'
}

function parseConstraintKey(key: string): SegConstraint {
  const [type, id] = key.split(':')
  if (type === 'overlay') return { type: 'overlay', overlayId: Number(id) }
  if (type === 'region') return { type: 'region', regionId: Number(id) }
  return { type: 'none' }
}

function dirOfPath(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut > 0 ? path.slice(0, cut) : ''
}

/**
 * Box ∩ constraint intensity histogram (log-scaled bars) with one vertical
 * marker per threshold. Marker positions clamp to the plot edges when a
 * threshold sits outside the box's intensity range.
 */
function HistogramView({
  hist,
  markers
}: {
  hist: HistogramResult
  markers: { value: number; color: string }[]
}): JSX.Element | null {
  const W = 240
  const H = 54
  const n = hist.counts.length
  if (n === 0 || hist.max <= hist.min) return null
  let maxCount = 0
  for (let i = 0; i < n; i++) if (hist.counts[i] > maxCount) maxCount = hist.counts[i]
  if (maxCount === 0) return null

  const barW = W / n
  const denom = Math.log1p(maxCount)
  let d = ''
  for (let i = 0; i < n; i++) {
    const h = (Math.log1p(hist.counts[i]) / denom) * (H - 2)
    if (h <= 0) continue
    d += `M${(i * barW).toFixed(2)} ${H}V${(H - h).toFixed(2)}H${((i + 1) * barW).toFixed(2)}V${H}`
  }
  const xOf = (v: number): number =>
    Math.min(Math.max((v - hist.min) / (hist.max - hist.min), 0), 1) * W

  return (
    <div className="seg-histogram-wrap">
      <svg
        className="seg-histogram"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d={d} fill="var(--bg-3)" />
        {markers.map((m, i) => (
          <line
            key={i}
            x1={xOf(m.value)}
            x2={xOf(m.value)}
            y1={0}
            y2={H}
            stroke={m.color}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="range-readout mono">
        <span>{fmt(hist.min)}</span>
        <span>{fmt(hist.max)}</span>
      </div>
    </div>
  )
}

function ThresholdSlider({
  label,
  value,
  min,
  max,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
}): JSX.Element {
  const span = Math.max(max - min, 1e-6)
  return (
    <div className="seg-field">
      <label>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={span / 256}
        value={Math.max(min, Math.min(value, max))}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="seg-unit mono">{fmt(value)}</span>
    </div>
  )
}

function SegmentControls({ box }: { box: SegBox }): JSX.Element {
  const volume = useStore((s) => s.volume)!
  const params = useStore((s) => s.segParams)
  const preview = useStore((s) => s.preview)
  const overlays = useStore((s) => s.overlays)
  const regions = useStore((s) => s.regions)
  const segSlabAxis = useStore((s) => s.segSlabAxis)
  const editRegionId = useStore((s) => s.editRegionId)
  const setSegParams = useStore((s) => s.setSegParams)
  const applyMethod = useStore((s) => s.applyMethod)
  const autoThreshold = useStore((s) => s.autoThreshold)
  const setSlabDepth = useStore((s) => s.setSlabDepth)
  const commitPreview = useStore((s) => s.commitPreview)
  const cancelSeg = useStore((s) => s.cancelSeg)

  const extent = boxExtent(box)
  const constrained = params.constraint.type !== 'none'
  const editTarget = regions.find((r) => r.id === editRegionId) ?? null
  const markers =
    params.method === 'threshold'
      ? [{ value: params.low, color: 'var(--accent)' }]
      : [
          { value: params.low, color: 'var(--accent)' },
          { value: params.high, color: '#ffc440' }
        ]

  return (
    <div className="seg-controls">
      {editTarget && (
        <div className="seg-hint seg-editing">
          Editing “{editTarget.name}” — committing replaces its voxels.
        </div>
      )}
      <div className="mono layer-dims">
        box {extent.join(' × ')} at ({box.min.join(', ')})
      </div>
      {segSlabAxis !== null && (
        <div className="seg-field">
          <label>Slab depth</label>
          <input
            className="seg-number mono"
            type="number"
            min={1}
            max={volume.dims[segSlabAxis]}
            value={extent[segSlabAxis]}
            onChange={(e) => setSlabDepth(Number(e.target.value) || 1)}
          />
          <span className="seg-unit">voxels (axis {segSlabAxis})</span>
        </div>
      )}
      <div className="preset-row">
        <button
          className={`preset-btn${params.method === 'threshold' ? ' active' : ''}`}
          title="The box surrounds the region; keep voxels at/above the threshold"
          onClick={() => applyMethod('threshold')}
        >
          Threshold
        </button>
        <button
          className={`preset-btn${params.method === 'grow' ? ' active' : ''}`}
          title="The box sits entirely inside the region; grow outward from its confident interior"
          onClick={() => applyMethod('grow')}
        >
          Grow
        </button>
      </div>
      <div className="seg-hint">
        {params.method === 'threshold'
          ? 'Draw the box around the region; the result stays inside the box.'
          : 'Draw the box fully inside the region; the grow can extend past it.'}
      </div>

      {preview && <HistogramView hist={preview.histogram} markers={markers} />}

      {params.method === 'threshold' ? (
        <>
          <ThresholdSlider
            label="Threshold ≥"
            value={params.low}
            min={THRESHOLD_RANGE[0]}
            max={THRESHOLD_RANGE[1]}
            onChange={(v) => setSegParams({ low: v, high: v })}
          />
          <div className="preset-row">
            <button
              className="preset-btn"
              title="Otsu split of the box histogram"
              onClick={() => autoThreshold('otsu')}
            >
              Auto (Otsu)
            </button>
            <button
              className="preset-btn"
              title="Threshold at the box mean intensity"
              onClick={() => autoThreshold('mean')}
            >
              Box mean
            </button>
          </div>
        </>
      ) : (
        <>
          <ThresholdSlider
            label="Seed ≥"
            value={params.high}
            min={GROW_SEED_RANGE[0]}
            max={GROW_SEED_RANGE[1]}
            onChange={(v) => setSegParams({ high: v })}
          />
          <ThresholdSlider
            label="Grow to ≥"
            value={params.low}
            min={GROW_BOUNDARY_RANGE[0]}
            max={GROW_BOUNDARY_RANGE[1]}
            onChange={(v) => setSegParams({ low: v })}
          />
          <div className="preset-row">
            <button
              className="preset-btn"
              title="Boundary threshold from the Otsu split of the box histogram"
              onClick={() => autoThreshold('otsu')}
            >
              Boundary: Otsu
            </button>
            <button
              className="preset-btn"
              title="Seed level from the box mean (the box is entirely region)"
              onClick={() => autoThreshold('mean')}
            >
              Seed: box mean
            </button>
          </div>
          {constrained ? (
            <div className="seg-hint">The constraint bounds the grow.</div>
          ) : (
            <div className="seg-field">
              <label>Grow reach</label>
              <input
                className="seg-number mono"
                type="number"
                min={0}
                placeholder="∞"
                value={params.growMargin ?? ''}
                onChange={(e) => {
                  const t = e.target.value.trim()
                  setSegParams({ growMargin: t === '' ? null : Math.max(0, Number(t) || 0) })
                }}
              />
              <span className="seg-unit">voxels past the box (empty = unlimited)</span>
            </div>
          )}
        </>
      )}

      <div className="seg-field">
        <label>Constrain to</label>
        <select
          value={constraintKey(params.constraint)}
          onChange={(e) => setSegParams({ constraint: parseConstraintKey(e.target.value) })}
        >
          <option value="none">None</option>
          {overlays.map((l) => (
            <option key={l.id} value={`overlay:${l.id}`}>
              Overlay: {l.volume.name}
            </option>
          ))}
          {regions.map((r) => (
            <option key={r.id} value={`region:${r.id}`}>
              Region: {r.name}
            </option>
          ))}
        </select>
      </div>

      <div className="seg-field">
        <label>Connectivity</label>
        <div className="preset-row" style={{ marginTop: 0 }}>
          {([6, 26] as const).map((c) => (
            <button
              key={c}
              className={`preset-btn${params.connectivity === c ? ' active' : ''}`}
              title={c === 6 ? 'Faces only' : 'Faces + edges + corners'}
              onClick={() => setSegParams({ connectivity: c })}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="seg-field">
        <label>Min piece size</label>
        <input
          className="seg-number mono"
          type="number"
          min={1}
          value={params.minVoxels}
          onChange={(e) => setSegParams({ minVoxels: Math.max(1, Number(e.target.value) || 1) })}
        />
        <span className="seg-unit">voxels</span>
      </div>

      <div className="seg-preview-row">
        <span className="mono seg-preview-stats">
          {preview
            ? `${preview.voxels.toLocaleString('en-US')} voxels · ${preview.components} piece${preview.components === 1 ? '' : 's'}`
            : 'computing…'}
        </span>
      </div>
      {preview?.truncated && (
        <div className="seg-hint seg-warning">
          The grow hit the safety cap — raise the thresholds, set a grow reach, or add a constraint.
        </div>
      )}
      <div className="preset-row">
        <button
          className="btn primary seg-commit"
          disabled={!preview || preview.voxels === 0}
          onClick={commitPreview}
        >
          {editTarget ? 'Update region' : 'Commit region'}
        </button>
        <button className="btn" onClick={cancelSeg}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/** Right-click menu of one region row. Closes on outside press or Escape. */
function RegionContextMenu({
  menu,
  onClose
}: {
  menu: { id: number; x: number; y: number }
  onClose: () => void
}): JSX.Element | null {
  const region = useStore((s) => s.regions.find((r) => r.id === menu.id) ?? null)
  const editRegion = useStore((s) => s.editRegion)
  const updateRegion = useStore((s) => s.updateRegion)
  const deleteRegion = useStore((s) => s.deleteRegion)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    // Capture phase so Escape closes the menu without also cancelling the
    // box / un-maximizing a view via the app-level handler.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  if (!region) return null
  const run =
    (fn: () => void): (() => void) =>
    () => {
      fn()
      onClose()
    }
  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{
        left: Math.min(menu.x, window.innerWidth - 170),
        top: Math.min(menu.y, window.innerHeight - 130)
      }}
    >
      <button onClick={run(() => editRegion(region.id))}>Re-segment…</button>
      <button onClick={run(() => updateRegion(region.id, { visible: !region.visible }))}>
        {region.visible ? 'Hide' : 'Show'}
      </button>
      <button className="danger" onClick={run(() => deleteRegion(region.id))}>
        Delete
      </button>
    </div>
  )
}

function RegionRow({
  region,
  onMenu
}: {
  region: Region
  onMenu: (e: React.MouseEvent) => void
}): JSX.Element {
  const activeRegionId = useStore((s) => s.activeRegionId)
  const setActiveRegion = useStore((s) => s.setActiveRegion)
  const updateRegion = useStore((s) => s.updateRegion)
  const deleteRegion = useStore((s) => s.deleteRegion)
  const active = activeRegionId === region.id

  return (
    <div
      className={`region-row${active ? ' active' : ''}${region.visible ? '' : ' off'}`}
      title="Click to select for the brush; right-click for actions (or right-click the region on a slice view)"
      onClick={() => setActiveRegion(region.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e)
      }}
    >
      <div className="layer-head">
        <input
          className="region-color"
          type="color"
          value={region.color}
          title="Region color"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => updateRegion(region.id, { color: e.target.value })}
        />
        <input
          className="region-name"
          type="text"
          value={region.name}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => updateRegion(region.id, { name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
        <button
          className="eye-btn"
          title={region.visible ? 'Hide region' : 'Show region'}
          aria-pressed={region.visible}
          onClick={(e) => {
            e.stopPropagation()
            updateRegion(region.id, { visible: !region.visible })
          }}
        >
          <EyeIcon off={!region.visible} />
        </button>
        <button
          className="preset-btn"
          aria-label="Delete region"
          title="Delete region (undo available)"
          onClick={(e) => {
            e.stopPropagation()
            deleteRegion(region.id)
          }}
        >
          ✕
        </button>
      </div>
      <div className="mono region-stats">
        {region.voxelCount.toLocaleString('en-US')} voxels
        {region.stats
          ? ` · mean ${fmt(region.stats.mean)} · ${fmt(region.stats.min)}–${fmt(region.stats.max)}`
          : ''}
      </div>
    </div>
  )
}

function ExportSection(): JSX.Element {
  const volume = useStore((s) => s.volume)!
  const sourcePath = useStore((s) => s.sourcePath)
  const labelMap = useStore((s) => s.labelMap)
  const regions = useStore((s) => s.regions)
  const segDirty = useStore((s) => s.segDirty)
  const markExported = useStore((s) => s.markExported)
  const setToast = useStore((s) => s.setToast)
  const fail = useStore((s) => s.fail)

  const [settings, setSettings] = useState<ExportSettings>(loadExportSettings)
  const [showSettings, setShowSettings] = useState(false)
  const [busy, setBusy] = useState(false)

  const patchSettings = (patch: Partial<ExportSettings>): void => {
    const next = { ...settings, ...patch }
    setSettings(next)
    saveExportSettings(next)
  }

  const visibleRegions = regions.filter((r) => r.visible)

  const doExport = async (kind: 'labels' | 'mask'): Promise<void> => {
    if (!labelMap || busy) return
    const dir = settings.dir || (sourcePath ? dirOfPath(sourcePath) : '')
    if (!dir) {
      fail('The source folder is unknown — pick an export folder in the export settings.')
      setShowSettings(true)
      return
    }
    setBusy(true)
    try {
      const payload =
        kind === 'labels'
          ? await buildLabelMapExport(volume, labelMap, regions, settings.format)
          : await buildMaskExport(volume, labelMap, visibleRegions, settings.format)
      const result = await window.neoview.exportFile({
        dir,
        fileName: payload.fileName,
        bytes: payload.bytes,
        sidecar: payload.sidecar
      })
      markExported()
      setToast({
        text: `Saved ${result.path.split(/[\\/]/).pop()}${result.sidecarPath ? ' + color table' : ''}`,
        action: { label: 'Show in file manager', kind: 'reveal', path: result.path }
      })
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="export-section">
      <div className="preset-row">
        <button
          className="preset-btn"
          disabled={busy || !labelMap}
          title="One label value per region + a plain-text color table"
          onClick={() => void doExport('labels')}
        >
          Export label map
        </button>
        <button
          className="preset-btn"
          disabled={busy || !labelMap}
          title="Single-value mask: 1 wherever any visible region has a voxel (none visible exports an empty mask)"
          onClick={() => void doExport('mask')}
        >
          Export mask
        </button>
        <button
          className={`preset-btn${showSettings ? ' active' : ''}`}
          aria-expanded={showSettings}
          title="Export settings"
          onClick={() => setShowSettings(!showSettings)}
        >
          ⚙
        </button>
      </div>
      {showSettings && (
        <div className="export-settings">
          <div className="seg-field">
            <label>Format</label>
            <div className="preset-row" style={{ marginTop: 0 }}>
              {(['nii.gz', 'nii'] as const).map((f) => (
                <button
                  key={f}
                  className={`preset-btn${settings.format === f ? ' active' : ''}`}
                  onClick={() => patchSettings({ format: f })}
                >
                  .{f}
                </button>
              ))}
            </div>
          </div>
          <div className="seg-field">
            <label>Folder</label>
            <span
              className="export-dir mono"
              title={settings.dir || 'Same folder as the opened file'}
            >
              {settings.dir || 'Same as source'}
            </span>
          </div>
          <div className="preset-row" style={{ marginTop: 4 }}>
            <button
              className="preset-btn"
              onClick={() =>
                void window.neoview.pickDirectory().then((dir) => {
                  if (dir) patchSettings({ dir })
                })
              }
            >
              Choose…
            </button>
            <button
              className="preset-btn"
              disabled={!settings.dir}
              onClick={() => patchSettings({ dir: '' })}
            >
              Same as source
            </button>
          </div>
        </div>
      )}
      {regions.length > 0 && (
        <div className={`seg-status${segDirty ? ' dirty' : ''}`}>
          {segDirty ? 'Unsaved changes' : 'Exported ✓'}
        </div>
      )}
    </div>
  )
}

export function RegionPanel(): JSX.Element | null {
  const volume = useStore((s) => s.volume)
  const segTool = useStore((s) => s.segTool)
  const segBox = useStore((s) => s.segBox)
  const regions = useStore((s) => s.regions)
  const activeRegionId = useStore((s) => s.activeRegionId)
  const brushRadius = useStore((s) => s.brushRadius)
  const regionOpacity = useStore((s) => s.regionOpacity)
  const setSegTool = useStore((s) => s.setSegTool)
  const setBrushRadius = useStore((s) => s.setBrushRadius)
  const setRegionOpacity = useStore((s) => s.setRegionOpacity)

  const [rowMenu, setRowMenu] = useState<{ id: number; x: number; y: number } | null>(null)

  if (!volume) return null

  return (
    <div className="panel-section region-panel">
      <h3>Regions</h3>
      <div className="preset-row" style={{ marginTop: 0 }}>
        {TOOLS.map((t) => (
          <button
            key={t.key}
            className={`preset-btn${segTool === t.key ? ' active' : ''}`}
            title={t.title}
            onClick={() => setSegTool(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {segTool === 'box' && !segBox && (
        <div className="seg-hint">
          Drag on a slice view to define a box, then tune the segmentation below. Drag its handles
          in any view to shape it in 3D.
        </div>
      )}
      {segTool === 'brush' && (
        <>
          <div className="frame-slider" style={{ marginTop: 8 }}>
            <input
              type="range"
              min={BRUSH_RADIUS_MIN}
              max={BRUSH_RADIUS_MAX}
              step={1}
              value={brushRadius}
              onChange={(e) => setBrushRadius(Number(e.target.value))}
            />
            <span className="frame-label mono">r {brushRadius}</span>
          </div>
          <div className="seg-hint">
            {activeRegionId === null
              ? 'Select a region below to paint into (commit one first if the list is empty).'
              : 'Paint on a slice to add voxels; Alt or right-drag erases. [ and ] change the radius.'}
          </div>
        </>
      )}

      {segBox && <SegmentControls box={segBox} />}

      {regions.length > 0 && (
        <div className="region-list">
          {regions.map((r) => (
            <RegionRow
              key={r.id}
              region={r}
              onMenu={(e) => setRowMenu({ id: r.id, x: e.clientX, y: e.clientY })}
            />
          ))}
        </div>
      )}
      {rowMenu && <RegionContextMenu menu={rowMenu} onClose={() => setRowMenu(null)} />}

      {regions.length > 0 && (
        <div className="frame-slider" style={{ marginTop: 10 }}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={regionOpacity}
            onChange={(e) => setRegionOpacity(Number(e.target.value))}
          />
          <span className="frame-label mono">op {regionOpacity.toFixed(2)}</span>
        </div>
      )}

      <ExportSection />
    </div>
  )
}
