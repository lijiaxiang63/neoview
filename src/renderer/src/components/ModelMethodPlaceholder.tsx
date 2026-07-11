import { type JSX } from 'react'
import {
  MODEL_ASSETS,
  MODEL_GROUPS,
  lowMemoryAlternative,
  modelClasses,
  modelGroup,
  modelVariant,
  variantsForGroup,
  type ModelGroupId,
  type ModelVariantId
} from '../model/catalog'
import { modelAvailability } from '../model/preprocess'
import type { ModelProgressStage } from '../model/protocol'
import { useStore } from '../store'

const STAGE_LABELS: Readonly<Record<ModelProgressStage, string>> = {
  prepare: 'Preparing input',
  load: 'Loading resources',
  prerequisite: 'Preparing crop',
  infer: 'Running model',
  writeback: 'Building preview'
}

function formatBytes(value: number): string {
  return value < 1_000_000
    ? `${(value / 1_000).toFixed(1)} kB`
    : `${(value / 1_000_000).toFixed(2)} MB`
}

/** Projects model state into the whole-volume controls. */
export function ModelMethodPlaceholder({ onClose }: { onClose: () => void }): JSX.Element {
  const volume = useStore((state) => state.volume)
  const run = useStore((state) => state.modelRun)
  const selectedId = useStore((state) => state.selectedModelVariantId)
  const setVariant = useStore((state) => state.setModelVariant)
  const start = useStore((state) => state.startModelRun)
  const cancel = useStore((state) => state.cancelModelRun)
  const discard = useStore((state) => state.discardModelPreview)
  const commit = useStore((state) => state.commitModelPreview)
  const availability = modelAvailability(volume)
  const selected = modelVariant(selectedId)
  const group = modelGroup(selected.groupId)
  const asset = MODEL_ASSETS[selected.assetId]
  const classes = modelClasses(run.preview?.variantId ?? selectedId)
  const present = run.preview
    ? classes.filter((item) => item.value !== 0 && run.preview!.counts[item.value] > 0)
    : []
  const total = present.reduce((sum, item) => sum + (run.preview?.counts[item.value] ?? 0), 0)
  const lowAlternative =
    run.status === 'error' && run.errorCode === 'run-failed'
      ? lowMemoryAlternative(selectedId)
      : null
  const outputText =
    selected.output === 'binary'
      ? `${asset.outputClasses} classes · merged to 1 region`
      : `${asset.outputClasses} classes`
  const executionHint =
    selected.execution === 'high'
      ? 'Faster execution; needs more graphics memory.'
      : 'Lower graphics-memory use; execution is slower.'

  return (
    <div className="model-placeholder">
      <div className="seg-field model-select-field">
        <label htmlFor="model-group">Model</label>
        <select
          id="model-group"
          value={group.id}
          disabled={run.status === 'running'}
          onChange={(event) =>
            setVariant(modelGroup(event.target.value as ModelGroupId).preferredVariantId)
          }
        >
          {MODEL_GROUPS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>
      <div className="seg-field model-select-field">
        <label htmlFor="model-mode">Mode</label>
        <select
          id="model-mode"
          value={selectedId}
          disabled={run.status === 'running'}
          onChange={(event) => setVariant(event.target.value as ModelVariantId)}
        >
          {variantsForGroup(group.id).map((item) => (
            <option key={item.id} value={item.id}>
              {item.modeName}
            </option>
          ))}
        </select>
      </div>
      <div className="model-meta mono">
        <span>{outputText}</span>
        <span>{asset.parameters.toLocaleString('en-US')} parameters</span>
        <span>{formatBytes(asset.bundleBytes)} built in</span>
      </div>
      <div className="seg-hint model-execution-hint">
        {executionHint}
        {selected.prerequisite && ' Includes an additional preparation stage.'}
      </div>

      {!availability.available && <div className="seg-hint model-error">{availability.reason}</div>}
      {run.status === 'error' && run.error && (
        <div className="seg-hint model-error">{run.error}</div>
      )}
      {run.status === 'error' && lowAlternative && (
        <button className="btn model-low-memory" onClick={() => setVariant(lowAlternative.id)}>
          Switch to {lowAlternative.modeName}
        </button>
      )}

      {run.status === 'preview' && run.preview && (
        <div className="model-preview-summary">
          <div className="seg-preview-stats mono">
            {present.length.toLocaleString('en-US')} active classes ·{' '}
            {total.toLocaleString('en-US')} voxels
          </div>
          <div className="model-class-list" aria-label="Preview classes">
            {present.map((item) => (
              <div className="model-class-row" key={item.value}>
                <span className="model-class-swatch" style={{ background: item.color }} />
                <span className="model-class-name" title={item.name}>
                  {item.name}
                </span>
                <span className="mono">
                  {run.preview!.counts[item.value].toLocaleString('en-US')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="preset-row" style={{ marginTop: 0 }}>
        {run.status === 'running' ? (
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
        ) : run.status === 'preview' ? (
          <>
            <button
              className="btn primary"
              disabled={present.length === 0}
              onClick={() => {
                commit()
                if (useStore.getState().modelRun.status === 'idle') onClose()
              }}
            >
              Commit
            </button>
            <button className="btn" onClick={discard}>
              Discard
            </button>
          </>
        ) : (
          <button className="btn primary" disabled={!availability.available} onClick={start}>
            {run.status === 'error' ? 'Retry' : 'Run'}
          </button>
        )}
      </div>

      <div className="model-progress-label" aria-live="polite">
        {run.status === 'running' && (
          <>
            <span>{STAGE_LABELS[run.stage]}</span>
            <span className="mono">{Math.round(run.progress * 100)}%</span>
          </>
        )}
      </div>
      <div
        className={`model-progress${run.status === 'running' ? ' active' : ''}`}
        role={run.status === 'running' ? 'progressbar' : undefined}
        aria-valuemin={run.status === 'running' ? 0 : undefined}
        aria-valuemax={run.status === 'running' ? 100 : undefined}
        aria-valuenow={run.status === 'running' ? Math.round(run.progress * 100) : undefined}
      >
        <span style={{ width: `${Math.round(run.progress * 100)}%` }} />
      </div>
    </div>
  )
}
