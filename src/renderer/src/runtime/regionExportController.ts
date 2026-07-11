import type { ExportRequest, ExportResult } from '../../../shared/files'
import type { AppStore } from '../store'
import { RegionExportClient } from '../segmentation/exportClient'
import {
  dirOfPath,
  loadExportSettings,
  saveExportSettings,
  type ExportSettings
} from '../segmentation/exportRegions'

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
  private readonly store: Pick<AppStore, 'getState'>
  private readonly bridge: RegionExportBridge
  private readonly client: RegionExportBuilder
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'>
  private snapshot: RegionExportSnapshot
  private active = true

  constructor(deps: {
    store: Pick<AppStore, 'getState'>
    bridge: RegionExportBridge
    storage: Pick<Storage, 'getItem' | 'setItem'>
    client?: RegionExportBuilder
  }) {
    this.store = deps.store
    this.bridge = deps.bridge
    this.storage = deps.storage
    this.client = deps.client ?? new RegionExportClient()
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

  dispose(): void {
    if (!this.active) return
    this.active = false
    this.client.dispose()
    this.listeners.clear()
  }

  private publish(snapshot: RegionExportSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
