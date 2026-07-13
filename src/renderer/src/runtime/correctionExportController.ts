// Writes a corrected stat map (+ cluster-report CSV sidecar) to disk. It reuses
// the region export destination/format setting so both products land in the same
// place, and routes through the same guarded main-side export channel.

import type { ExportRequest, ExportResult } from '../../../shared/files'
import type { AppStore } from '../store'
import { dirOfPath, exportBaseName, loadExportSettings } from '../segmentation/exportRegions'
import { buildCorrectedExport } from '../stats/correctionExport'
import type { OverlayLayer } from '../slicing/overlay'

export interface CorrectionExportBridge {
  exportFile(request: ExportRequest): Promise<ExportResult>
}

export class CorrectionExportController {
  private readonly store: Pick<AppStore, 'getState'>
  private readonly bridge: CorrectionExportBridge
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'>
  private active = true
  private busy = false

  constructor(deps: {
    store: Pick<AppStore, 'getState'>
    bridge: CorrectionExportBridge
    storage: Pick<Storage, 'getItem' | 'setItem'>
  }) {
    this.store = deps.store
    this.bridge = deps.bridge
    this.storage = deps.storage
  }

  /** Export the layer's corrected map. Returns false when no destination folder
   * is known so the caller can surface the region export settings. */
  async export(layer: OverlayLayer): Promise<boolean> {
    if (!this.active || this.busy) return true
    const sig = layer.significance
    if (!sig) return true
    const state = this.store.getState()
    const settings = loadExportSettings(this.storage)
    const dir =
      settings.dir ||
      (layer.sourcePath
        ? dirOfPath(layer.sourcePath)
        : state.sourcePath
          ? dirOfPath(state.sourcePath)
          : '')
    if (!dir) {
      state.fail('The source folder is unknown — pick an export folder in the export settings.')
      return false
    }
    this.busy = true
    const volumeSession = state.volumeSession
    try {
      // Export the frame the significance describes — not the currently-displayed
      // frame, which may differ (a recompute is debounced + async), or the mask
      // and threshold would gate the wrong frame's voxels.
      const payload = await buildCorrectedExport(
        layer.volume,
        sig,
        sig.frame,
        exportBaseName(layer.volume.name),
        settings.format
      )
      if (!this.active) return true
      const result = await this.bridge.exportFile({ dir, ...payload })
      if (!this.active || this.store.getState().volumeSession !== volumeSession) return true
      this.store.getState().pushToast({
        text: `Saved ${result.path.split(/[\\/]/).pop()}${
          result.sidecarPath ? ' + cluster report' : ''
        }`,
        variant: 'success',
        action: { label: 'Show in file manager', kind: 'reveal', path: result.path }
      })
    } catch (error) {
      if (this.active) {
        this.store.getState().fail(error instanceof Error ? error.message : 'Export failed.')
      }
    } finally {
      this.busy = false
    }
    return true
  }

  dispose(): void {
    this.active = false
  }
}
