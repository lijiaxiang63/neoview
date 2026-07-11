import { type JSX } from 'react'

/**
 * Reserved layout for a future model-based segmentation tool that runs on
 * the whole volume (no box required — it sits beside the drawing tools).
 * Pure UI: nothing here reaches the store, the preview lifecycle, or a
 * worker.
 *
 * To implement the real tool: add its state/actions to
 * store/regionDomain.ts, run the model in its own worker with progress
 * reported into this layout, and commit the delivered mask through the
 * existing label-map commit path (segmentation/regions.ts) so undo/redo,
 * statistics, and export work unchanged.
 */
export function ModelMethodPlaceholder(): JSX.Element {
  return (
    <div className="model-placeholder">
      <div className="seg-hint">
        Model-based segmentation of the whole volume is not available yet.
      </div>
      <div className="seg-field">
        <label>Model</label>
        <select disabled>
          <option>Built-in (coming soon)</option>
        </select>
      </div>
      <div className="preset-row" style={{ marginTop: 0 }}>
        <button className="btn primary" disabled>
          Run
        </button>
      </div>
      <div className="model-progress" aria-hidden="true" />
    </div>
  )
}
