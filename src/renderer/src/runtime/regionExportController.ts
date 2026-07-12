import type { ExportRequest, ExportResult } from '../../../shared/files'
import type { AppStore } from '../store'
import { RegionExportClient } from '../segmentation/exportClient'
import {
  dirOfPath,
  loadExportSettings,
  saveExportSettings,
  type ExportSettings
} from '../segmentation/exportRegions'
import type { Volume } from '../volume/types'
import { layerFileName, parseLayerLabelTable } from '../slicing/labelTable'

export interface RegionExportBridge {
  exportFile(request: ExportRequest): Promise<ExportResult>
  pickDirectory(): Promise<string | null>
}

export interface RegionExportSnapshot {
  settings: ExportSettings
  busy: boolean
}

export type RegionExportBuilder = Pick<RegionExportClient, 'build' | 'dispose'>

export class RegionExportController {
  private readonly listeners = new Set<() => void>()
  private readonly store: Pick<AppStore, 'getState' | 'subscribe'>
  private readonly bridge: RegionExportBridge
  private readonly client: RegionExportBuilder
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'>
  private readonly loadVolume?: (
    name: string,
    bytes: ArrayBuffer,
    options: { skipTex: true; signal: AbortSignal }
  ) => Promise<Volume>
  private snapshot: RegionExportSnapshot
  private active = true
  private archiveAbort: AbortController | null = null

  constructor(deps: {
    store: Pick<AppStore, 'getState' | 'subscribe'>
    bridge: RegionExportBridge
    storage: Pick<Storage, 'getItem' | 'setItem'>
    client?: RegionExportBuilder
    loadVolume?: (
      name: string,
      bytes: ArrayBuffer,
      options: { skipTex: true; signal: AbortSignal }
    ) => Promise<Volume>
  }) {
    this.store = deps.store
    this.bridge = deps.bridge
    this.storage = deps.storage
    this.client = deps.client ?? new RegionExportClient()
    this.loadVolume = deps.loadVolume
    this.snapshot = { settings: loadExportSettings(this.storage), busy: false }
  }

  subscribe = (listener: () => void): (() => void) => {
    if (!this.active) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): RegionExportSnapshot => this.snapshot

  patchSettings(patch: Partial<ExportSettings>): void {
    if (!this.active) return
    const settings = { ...this.snapshot.settings, ...patch }
    saveExportSettings(settings, this.storage)
    this.publish({ ...this.snapshot, settings })
  }

  async pickDirectory(): Promise<void> {
    const directory = await this.bridge.pickDirectory()
    if (this.active && directory) this.patchSettings({ dir: directory })
  }

  /** False means the caller should reveal settings because no destination is known. */
  async export(kind: 'labels' | 'mask'): Promise<boolean> {
    if (!this.active || this.snapshot.busy) return true
    const state = this.store.getState()
    const { volume, labelMap, regions, sourcePath, segRevision } = state
    if (!volume || !labelMap) return true
    const directory = this.snapshot.settings.dir || (sourcePath ? dirOfPath(sourcePath) : '')
    if (!directory) {
      state.fail('The source folder is unknown — pick an export folder in the export settings.')
      return false
    }
    const settings = this.snapshot.settings
    this.publish({ ...this.snapshot, busy: true })
    try {
      const payload = await this.client.build(kind, volume, labelMap, regions, settings.format)
      if (!this.active) return true
      const result = await this.bridge.exportFile({ dir: directory, ...payload })
      if (!this.active) return true
      const current = this.store.getState()
      current.markExported(volume, sourcePath, segRevision)
      current.pushToast({
        text: `Saved ${result.path.split(/[\\/]/).pop()}${result.sidecarPath ? ' + color table' : ''}`,
        variant: 'success',
        action: { label: 'Show in file manager', kind: 'reveal', path: result.path }
      })
    } catch (error) {
      if (this.active && !(error instanceof Error && error.name === 'AbortError')) {
        this.store.getState().fail(error instanceof Error ? error.message : 'Export failed.')
      }
    } finally {
      if (this.active) this.publish({ ...this.snapshot, busy: false })
    }
    return true
  }

  /** Save the multi-value result, add it as a layer, then clear the exact state exported. */
  async exportToLayerAndClear(): Promise<boolean> {
    if (!this.active || this.snapshot.busy) return true
    const state = this.store.getState()
    const { volume, volumeSession, labelMap, regions, sourcePath, segRevision } = state
    if (!volume || !labelMap) return true
    const directory = this.snapshot.settings.dir || (sourcePath ? dirOfPath(sourcePath) : '')
    if (!directory) {
      state.fail('The source folder is unknown — pick an export folder in the export settings.')
      return false
    }
    if (!this.loadVolume) {
      state.fail('Layer preparation is unavailable.')
      return true
    }
    const settings = this.snapshot.settings
    const abort = new AbortController()
    this.archiveAbort = abort
    this.publish({ ...this.snapshot, busy: true })
    let saved: ExportResult | null = null
    let ownershipLost = false
    let unsubscribeOwnership: (() => void) | null = null
    try {
      const payload = await this.client.build('labels', volume, labelMap, regions, settings.format)
      if (!this.active || abort.signal.aborted) return true
      saved = await this.bridge.exportFile({ dir: directory, ...payload })
      if (!this.active || abort.signal.aborted) return true
      const stillOwnsSnapshot = (): boolean => {
        const current = this.store.getState()
        return (
          current.volume === volume &&
          current.volumeSession === volumeSession &&
          current.segRevision === segRevision
        )
      }
      if (!stillOwnsSnapshot()) {
        this.publishSavedWithoutClear(saved.path)
        return true
      }
      const table = payload.sidecar ? parseLayerLabelTable(payload.sidecar.text).table : null
      if (!table) throw new Error('The exported layer table has no valid entries.')
      unsubscribeOwnership = this.store.subscribe(() => {
        if (stillOwnsSnapshot()) return
        ownershipLost = true
        abort.abort()
      })
      const layer = await this.loadVolume(layerFileName(saved.path), payload.bytes, {
        skipTex: true,
        signal: abort.signal
      })
      unsubscribeOwnership()
      unsubscribeOwnership = null
      if (ownershipLost) {
        this.publishSavedWithoutClear(saved.path)
        return true
      }
      if (!this.active || abort.signal.aborted) return true
      const current = this.store.getState()
      if (!stillOwnsSnapshot()) {
        this.publishSavedWithoutClear(saved.path)
        return true
      }
      if (!current.clearRegions(true)) {
        current.fail('Files were saved, but regions could not be cleared. No layer was added.')
        return true
      }
      current.addOverlay(layer, {
        settleLoad: false,
        sourcePath: saved.path,
        labelTable: table,
        labelTableName: saved.sidecarPath
      })
      current.markExported(volume, sourcePath, segRevision)
      current.setSidePanelTab('layers')
      current.pushToast({
        text: `Saved ${layerFileName(saved.path)} and added it as a layer.`,
        variant: 'success',
        action: { label: 'Show in file manager', kind: 'reveal', path: saved.path }
      })
    } catch (error) {
      if (this.active && ownershipLost && saved) {
        this.publishSavedWithoutClear(saved.path)
      } else if (this.active && !(error instanceof Error && error.name === 'AbortError')) {
        const message = error instanceof Error ? error.message : 'Export failed.'
        this.store
          .getState()
          .fail(
            saved
              ? `Files were saved, but the layer could not be added. Regions were not cleared. ${message}`
              : message
          )
      }
    } finally {
      unsubscribeOwnership?.()
      if (this.archiveAbort === abort) this.archiveAbort = null
      if (this.active) this.publish({ ...this.snapshot, busy: false })
    }
    return true
  }

  private publishSavedWithoutClear(path: string): void {
    this.store.getState().pushToast({
      text: `Saved ${layerFileName(path)}; current regions were left unchanged.`,
      variant: 'success',
      action: { label: 'Show in file manager', kind: 'reveal', path }
    })
  }

  dispose(): void {
    if (!this.active) return
    this.active = false
    this.archiveAbort?.abort()
    this.archiveAbort = null
    this.client.dispose()
    this.listeners.clear()
  }

  private publish(snapshot: RegionExportSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
