import { type JSX } from 'react'
import { CollapsibleSection } from './CollapsibleSection'
import { NumberField } from './NumberField'
import { fmt } from '../format'
import { useStore } from '../store'
import { overlayVoxelToBase, type OverlayLayer } from '../slicing/overlay'
import { ATLAS_CATALOG } from '../stats/atlasCatalog'
import {
  defaultCorrectionConfig,
  type CorrectionConfig,
  type CorrectionStatistic
} from '../stats/correctionConfig'
import type { CorrectionMethod } from '../stats/correction'
import type { StatisticKind, Tail } from '../stats/pValues'
import type { Connectivity } from '../stats/connectedComponents'

const METHODS: { key: CorrectionMethod; label: string; title: string }[] = [
  { key: 'uncorrected', label: 'None', title: 'Uncorrected voxel threshold' },
  { key: 'bonferroni', label: 'FWE', title: 'Bonferroni family-wise error' },
  { key: 'fdr', label: 'FDR', title: 'False discovery rate (Benjamini-Hochberg)' },
  { key: 'cluster-grf', label: 'GRF', title: 'Cluster-extent (Gaussian random field)' }
]

const KINDS: { key: StatisticKind; label: string }[] = [
  { key: 't', label: 't' },
  { key: 'z', label: 'z' },
  { key: 'f', label: 'F' },
  { key: 'p', label: 'p' }
]

/** t needs a positive dof; F needs both — otherwise correction can't run. */
function dofMissing(cfg: CorrectionConfig): boolean {
  if (cfg.statistic.kind === 't') return !(cfg.statistic.dof1 >= 1)
  if (cfg.statistic.kind === 'f') return !(cfg.statistic.dof1 >= 1 && cfg.statistic.dof2 >= 1)
  return false
}

/** Correction config + live-threshold readout for a stat-map overlay layer. */
export function CorrectionControls({
  layer,
  onPatch,
  onExport
}: {
  layer: OverlayLayer
  onPatch: (patch: Partial<OverlayLayer>) => void
  onExport: () => void
}): JSX.Element {
  const cfg = layer.correction

  const setConfig = (partial: Partial<CorrectionConfig>): void => {
    if (!cfg) return
    onPatch({ correction: { ...cfg, ...partial, rev: cfg.rev + 1 } })
  }
  const setStatistic = (partial: Partial<CorrectionStatistic>): void => {
    if (!cfg) return
    setConfig({ statistic: { ...cfg.statistic, ...partial } })
  }
  const selectKind = (kind: StatisticKind): void => {
    if (!cfg) return
    // F is inherently one-sided; pin the tail when switching to it.
    if (kind === 'f') setConfig({ statistic: { ...cfg.statistic, kind }, tail: 'one' })
    else setStatistic({ kind })
  }

  return (
    <CollapsibleSection title="Correction" defaultOpen={true}>
      <label className="corr-check">
        <input
          type="checkbox"
          checked={cfg !== null}
          onChange={() =>
            onPatch({ correction: cfg ? null : defaultCorrectionConfig(layer.volume.statistic) })
          }
        />
        <span>Multiple-comparison correction</span>
      </label>

      {cfg && (
        <>
          <div className="corr-field">
            <span className="corr-label">Statistic</span>
            <div className="preset-row">
              {KINDS.map((k) => (
                <button
                  key={k.key}
                  className={`preset-btn${cfg.statistic.kind === k.key ? ' active' : ''}`}
                  onClick={() => selectKind(k.key)}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>

          {(cfg.statistic.kind === 't' || cfg.statistic.kind === 'f') && (
            <div className="corr-field">
              <span className="corr-label">{cfg.statistic.kind === 'f' ? 'df num' : 'df'}</span>
              <NumberField
                aria-label="degrees of freedom"
                value={cfg.statistic.dof1}
                min={1}
                onCommit={(v) => setStatistic({ dof1: v })}
              />
            </div>
          )}
          {cfg.statistic.kind === 'f' && (
            <div className="corr-field">
              <span className="corr-label">df den</span>
              <NumberField
                aria-label="denominator degrees of freedom"
                value={cfg.statistic.dof2}
                min={1}
                onCommit={(v) => setStatistic({ dof2: v })}
              />
            </div>
          )}

          <div className="corr-field">
            <span className="corr-label">Method</span>
            <select
              className="corr-select mono"
              value={cfg.method}
              onChange={(e) => setConfig({ method: e.target.value as CorrectionMethod })}
            >
              {METHODS.map((m) => (
                <option key={m.key} value={m.key} title={m.title}>
                  {m.title}
                </option>
              ))}
            </select>
          </div>

          <MaskSelect
            layer={layer}
            value={cfg.maskLayerId}
            onChange={(id) => setConfig({ maskLayerId: id })}
          />

          <div className="corr-field">
            <span className="corr-label">{cfg.method === 'fdr' ? 'q' : 'α'}</span>
            <NumberField
              aria-label="significance level"
              value={cfg.alpha}
              min={0}
              max={1}
              onCommit={(v) => setConfig({ alpha: v })}
            />
          </div>

          {cfg.method === 'cluster-grf' && (
            <>
              <div className="corr-field">
                <span className="corr-label">Cluster p</span>
                <NumberField
                  aria-label="cluster-forming p"
                  value={cfg.clusterFormingP}
                  min={0}
                  max={1}
                  onCommit={(v) => setConfig({ clusterFormingP: v })}
                />
              </div>
              <div className="corr-field">
                <span className="corr-label">Neighbors</span>
                <div className="preset-row">
                  {([6, 26] as Connectivity[]).map((c) => (
                    <button
                      key={c}
                      className={`preset-btn${cfg.connectivity === c ? ' active' : ''}`}
                      onClick={() => setConfig({ connectivity: c })}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {cfg.statistic.kind !== 'f' && (
            <div className="corr-field">
              <span className="corr-label">Sided</span>
              <div className="preset-row">
                {(['two', 'one'] as Tail[]).map((t) => (
                  <button
                    key={t}
                    className={`preset-btn${cfg.tail === t ? ' active' : ''}`}
                    onClick={() => setConfig({ tail: t })}
                  >
                    {t === 'two' ? 'Two' : 'One'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {dofMissing(cfg) ? (
            <div className="corr-readout">Enter degrees of freedom to correct this map.</div>
          ) : (
            <CorrectionReadout layer={layer} />
          )}
          <div className="corr-field">
            <span className="corr-label">Atlas</span>
            <AtlasSelect />
          </div>
          <ClusterTable layer={layer} />
          {layer.significance && (
            <div className="corr-field">
              <button className="preset-btn" onClick={onExport}>
                Export corrected map
              </button>
            </div>
          )}
        </>
      )}
    </CollapsibleSection>
  )
}

/** Cluster list from the correction report; each row jumps the crosshair to the
 * cluster's peak. */
function ClusterTable({ layer }: { layer: OverlayLayer }): JSX.Element | null {
  const base = useStore((s) => s.volume)
  const setCross = useStore((s) => s.setCross)
  const report = layer.significance?.report
  if (!report || report.records.length === 0) return null

  const jumpTo = (peakVoxel: [number, number, number]): void => {
    if (!base) return
    const ijk = overlayVoxelToBase(base, layer.volume, peakVoxel)
    if (ijk) setCross(ijk)
  }

  return (
    <CollapsibleSection title="Clusters" badge={String(report.records.length)} defaultOpen={false}>
      <div className="cluster-list">
        <div className="cluster-row cluster-head mono">
          <span>#</span>
          <span>vox</span>
          <span>peak</span>
          <span className="cluster-region">region</span>
        </div>
        {report.records.map((r) => (
          <button
            key={r.id}
            className="cluster-row mono"
            title={`peak at world ${r.peakWorld.map((v) => v.toFixed(1)).join(', ')}${
              r.regions ? ` · ${r.regions}` : ''
            }`}
            onClick={() => jumpTo(r.peakVoxel)}
          >
            <span>{r.id}</span>
            <span>{r.voxelCount}</span>
            <span>{fmt(r.peakStat)}</span>
            <span className="cluster-region">{r.peakRegion ?? '—'}</span>
          </button>
        ))}
      </div>
    </CollapsibleSection>
  )
}

/** Global selector for the atlas used to annotate cluster reports. */
function AtlasSelect(): JSX.Element {
  const atlas = useStore((s) => s.correctionAtlas)
  const setAtlas = useStore((s) => s.setCorrectionAtlas)
  return (
    <select
      className="corr-select mono"
      value={atlas ?? ''}
      onChange={(e) => setAtlas(e.target.value || null)}
    >
      <option value="">None</option>
      {ATLAS_CATALOG.map((a) => (
        <option key={a.id} value={a.id}>
          {a.label}
        </option>
      ))}
    </select>
  )
}

/** Selector for another overlay layer whose non-zero voxels restrict where the
 * correction is applied. */
function MaskSelect({
  layer,
  value,
  onChange
}: {
  layer: OverlayLayer
  value: number | null
  onChange: (id: number | null) => void
}): JSX.Element {
  const overlays = useStore((s) => s.overlays)
  const candidates = overlays.filter((l) => l.id !== layer.id)
  return (
    <>
      <div className="corr-field">
        <span className="corr-label">Mask</span>
        <select
          className="corr-select mono"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        >
          <option value="">Whole map (finite, non-zero)</option>
          {candidates.map((l) => (
            <option key={l.id} value={l.id}>
              {l.volume.name}
            </option>
          ))}
        </select>
      </div>
      {candidates.length === 0 && (
        <div className="corr-hint">
          No other layers loaded — correction spans the whole map. Load another layer to restrict it
          to that layer&apos;s non-zero voxels.
        </div>
      )}
    </>
  )
}

function CorrectionReadout({ layer }: { layer: OverlayLayer }): JSX.Element | null {
  const sig = layer.significance
  if (!sig) return null
  const gate = !Number.isFinite(sig.statThreshold)
    ? 'no voxels pass'
    : sig.kind === 'p'
      ? `p ≤ ${fmt(sig.statThreshold)}`
      : `|${sig.kind}| ≥ ${fmt(sig.statThreshold)}`
  return (
    <div className="corr-readout mono">
      <div>{sig.stale ? 'computing…' : gate}</div>
      <div>{sig.survivingVoxels.toLocaleString()} voxels survive</div>
      {sig.minClusterSize !== null && <div>min cluster {sig.minClusterSize} vox</div>}
      {sig.smoothness && <div>FWHM {sig.smoothness.fwhm.map((f) => f.toFixed(1)).join(' / ')}</div>}
    </div>
  )
}
