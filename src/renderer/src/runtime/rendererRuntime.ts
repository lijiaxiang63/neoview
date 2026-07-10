import type { FilePanelState, FolderEntry, FolderScan, OpenedFile } from '../../../shared/files'
import type { AppState, AppStore } from '../store'
import { MAX_BYTES } from '../volume/gunzip'
import type { Volume } from '../volume/types'
import { LoadCoordinator, type CoordinatorEffects, type ScanResult } from '../files/loadCoordinator'
import { filterEntries, regionExportSource, regionExportView } from '../files/folderList'
import {
  acceptsVolumeFileName,
  discardWarning,
  dropTargetAt,
  ipcErrorMessage,
  keyCommand,
  menuHistoryTarget,
  sameViewMenuSnapshot,
  viewMenuSnapshot,
  type LoadTarget
} from './appEvents'

export interface RendererBridge {
  platform: string
  openDialog(): Promise<OpenedFile | null>
  onFileOpened(callback: (file: OpenedFile) => void): () => void
  onOverlayOpened(callback: (file: OpenedFile) => void): () => void
  onFileOpenError(callback: (message: string) => void): () => void
  onOpenFolderRequest(callback: () => void): () => void
  onShowShortcuts(callback: () => void): () => void
  onMenuUndo(callback: () => void): () => void
  onMenuRedo(callback: () => void): () => void
  onScanFolderProgress(
    callback: (token: number, root: string, files: FolderEntry[]) => void
  ): () => void
  onCloseRequested(callback: () => void): () => void
  onToggleFilePanel(callback: () => void): () => void
  onToggleSidePanel(callback: () => void): () => void
  openFolderScan(token: number): Promise<FolderScan | null>
  scanDroppedFolder(file: File, token: number): Promise<FolderScan | null>
  isDirectory(path: string): Promise<boolean>
  pathForFile(file: File): string
  readFile(path: string): Promise<OpenedFile>
  readFileWithin(path: string, maxBytes: number): Promise<OpenedFile | null>
  noteFileOpened(path: string): void
  sendViewState(state: FilePanelState): void
  confirmFolderScan(token: number): void
  cancelFolderScan(token: number): void
  releaseFolderAccess(): void
  confirmClose(): void
  cancelClose(): void
}

export interface RuntimeEventTarget {
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

export interface RuntimeDocument {
  activeElement: unknown
  title: string
  execCommand(command: string): boolean
}

export interface RuntimeCoordinator {
  openBase(name: string, bytes: ArrayBuffer, path: string | null): Promise<void>
  openOverlay(name: string, bytes: ArrayBuffer): Promise<void>
  requestEntry(path: string): void
  navigate(delta: 1 | -1): void
  scanFolder(scan: (token: number) => Promise<ScanResult | null>): Promise<boolean>
  onScanBatch(token: number, root: string, files: FolderEntry[]): void
  releasePrefetch(): void
  dispose(): void
}

export type RuntimeCoordinatorFactory<V> = (
  effects: CoordinatorEffects<V>,
  options: { deferAutoLoad(entry: FolderEntry): boolean }
) => RuntimeCoordinator

export interface RendererRuntimeDeps {
  store: Pick<AppStore, 'getState' | 'subscribe'>
  bridge: RendererBridge
  windowTarget: RuntimeEventTarget
  documentTarget: RuntimeDocument
  loadVolume(name: string, bytes: ArrayBuffer, options?: { skipTex: true }): Promise<Volume>
  volumesAlign(base: Volume, overlay: Volume): boolean
  confirm(message: string): boolean
  createCoordinator?: RuntimeCoordinatorFactory<Volume>
  maxBytes?: number
}

export interface RuntimeUiState {
  dragging: boolean
  dropTarget: LoadTarget
}

export interface RendererRuntime {
  readonly platform: string
  init(): void
  dispose(): void
  openFileDialog(): Promise<void>
  addOverlayDialog(): Promise<void>
  openFolderDialog(): Promise<void>
  requestEntry(path: string): void
  subscribeUi(listener: () => void): () => void
  getUiSnapshot(): RuntimeUiState
}

const INITIAL_UI: RuntimeUiState = { dragging: false, dropTarget: 'auto' }

class OwnedRendererRuntime implements RendererRuntime {
  readonly platform: string

  private coordinator: RuntimeCoordinator | null = null
  private active = false
  private disposed = false
  private folderFlowActive = false
  private dragDepth = 0
  private uiState = INITIAL_UI
  private readonly uiListeners = new Set<() => void>()
  private readonly ipcUnsubscribes: Array<() => void> = []
  private readonly windowListeners: Array<[type: string, listener: EventListener]> = []
  private storeUnsubscribe: (() => void) | null = null
  private lastViewState: FilePanelState | null = null
  private lastTitle: string | null = null

  constructor(private readonly deps: RendererRuntimeDeps) {
    this.platform = deps.bridge.platform
  }

  init(): void {
    if (this.active || this.disposed) return
    const createCoordinator =
      this.deps.createCoordinator ??
      ((effects, options): RuntimeCoordinator => new LoadCoordinator<Volume>(effects, options))
    this.coordinator = createCoordinator(this.coordinatorEffects(), {
      deferAutoLoad: (entry) => regionExportSource(entry.name) !== null
    })
    this.active = true
    try {
      this.registerStoreBridge()
      this.registerIpcBridge()
      this.registerWindowEvents()
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.active = false
    this.folderFlowActive = false

    for (const unsubscribe of this.ipcUnsubscribes.splice(0).reverse()) unsubscribe()
    for (const [type, listener] of this.windowListeners.splice(0).reverse()) {
      this.deps.windowTarget.removeEventListener(type, listener)
    }
    this.storeUnsubscribe?.()
    this.storeUnsubscribe = null

    this.coordinator?.dispose()
    this.coordinator = null
    this.dragDepth = 0
    this.uiState = INITIAL_UI
    this.uiListeners.clear()
    this.lastViewState = null
    this.lastTitle = null
  }

  openFileDialog = async (): Promise<void> => {
    if (!this.active) return
    try {
      const opened = await this.deps.bridge.openDialog()
      if (!this.active || !opened) return
      await this.coordinator?.openBase(opened.name, opened.bytes, opened.path)
    } catch (error) {
      if (this.active) this.deps.store.getState().fail(ipcErrorMessage(error))
    }
  }

  addOverlayDialog = async (): Promise<void> => {
    if (!this.active) return
    try {
      const opened = await this.deps.bridge.openDialog()
      if (!this.active || !opened) return
      await this.coordinator?.openOverlay(opened.name, opened.bytes)
    } catch (error) {
      if (this.active) this.deps.store.getState().fail(ipcErrorMessage(error))
    }
  }

  openFolderDialog = async (): Promise<void> => {
    if (!this.active || this.folderFlowActive || this.deps.store.getState().folderLoading) return
    this.folderFlowActive = true
    try {
      await this.coordinator?.scanFolder((token) => this.deps.bridge.openFolderScan(token))
    } catch (error) {
      if (this.active) this.deps.store.getState().fail(ipcErrorMessage(error))
    } finally {
      this.folderFlowActive = false
    }
  }

  requestEntry = (path: string): void => {
    if (this.active) this.coordinator?.requestEntry(path)
  }

  subscribeUi = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.uiListeners.add(listener)
    return () => this.uiListeners.delete(listener)
  }

  getUiSnapshot = (): RuntimeUiState => this.uiState

  private coordinatorEffects(): CoordinatorEffects<Volume> {
    const { bridge, store } = this.deps
    return {
      snapshot: () => {
        const state = store.getState()
        return {
          sourcePath: state.sourcePath,
          loading: state.loadState === 'loading',
          scanning: state.folderLoading,
          folderRoot: state.folder?.root ?? null,
          folderFiles: state.folder
            ? filterEntries(regionExportView(state.folder.files).files, state.fileFilter)
            : null
        }
      },
      read: (path) => bridge.readFile(path),
      readWithin: (path, maxBytes) => bridge.readFileWithin(path, maxBytes),
      parseBase: (name, bytes) => this.deps.loadVolume(name, bytes),
      commitBase: (volume, path) => {
        if (!this.active) return
        store.getState().setVolume(volume, path)
        if (path) bridge.noteFileOpened(path)
      },
      parseAndAddOverlay: async (name, bytes) => {
        const volume = await this.deps.loadVolume(name, bytes, { skipTex: true })
        if (!this.active) return
        const state = store.getState()
        if (!state.volume) {
          state.fail('Load the base volume first.')
        } else if (!this.deps.volumesAlign(state.volume, volume)) {
          state.fail('Overlay could not be aligned: its affine is not invertible.')
        } else {
          state.addOverlay(volume)
        }
      },
      confirmReplaceBase: () => this.confirmDiscard(),
      raiseLoading: () => store.getState().startLoading(),
      dismissLoading: () => store.getState().dismissError(),
      failParse: (error) =>
        store.getState().fail(error instanceof Error ? error.message : 'Could not open file.'),
      failRead: (error) => store.getState().fail(ipcErrorMessage(error)),
      setPending: (path) => store.getState().setPendingFilePath(path),
      setFolder: (folder) => store.getState().setFolder(folder),
      appendFolder: (root, files) => store.getState().appendFolderFiles(root, files),
      setScanning: (scanning) => store.getState().setFolderLoading(scanning),
      confirmScan: (token) => bridge.confirmFolderScan(token),
      cancelScan: (token) => bridge.cancelFolderScan(token)
    }
  }

  private confirmDiscard(): boolean {
    if (!this.active) return false
    const warning = discardWarning(this.deps.store.getState())
    return warning === null || this.deps.confirm(warning)
  }

  private registerStoreBridge(): void {
    const { store } = this.deps
    const initial = store.getState()
    this.syncStoreState(initial)
    this.storeUnsubscribe = store.subscribe((state, previous) => {
      if (!this.active) return
      if (previous.folder !== null && state.folder === null) {
        this.coordinator?.releasePrefetch()
        this.deps.bridge.releaseFolderAccess()
      }
      this.syncStoreState(state)
    })
  }

  private syncStoreState(state: AppState): void {
    const title = state.volume ? `${state.volume.name} — neoview` : 'neoview'
    if (title !== this.lastTitle) {
      this.lastTitle = title
      this.deps.documentTarget.title = title
    }
    const next = viewMenuSnapshot(state)
    if (sameViewMenuSnapshot(this.lastViewState, next)) return
    this.lastViewState = next
    this.deps.bridge.sendViewState(next)
  }

  private registerIpcBridge(): void {
    const { bridge, store } = this.deps
    const keep = (unsubscribe: () => void): void => {
      this.ipcUnsubscribes.push(unsubscribe)
    }
    keep(
      bridge.onToggleFilePanel(() => {
        if (this.active) store.getState().toggleFilePanel()
      })
    )
    keep(
      bridge.onToggleSidePanel(() => {
        if (this.active) store.getState().toggleSidePanel()
      })
    )
    keep(
      bridge.onFileOpened((file) => {
        if (this.active) void this.coordinator?.openBase(file.name, file.bytes, file.path || null)
      })
    )
    keep(
      bridge.onOverlayOpened((file) => {
        if (this.active) void this.coordinator?.openOverlay(file.name, file.bytes)
      })
    )
    keep(
      bridge.onFileOpenError((message) => {
        if (this.active) store.getState().fail(message)
      })
    )
    keep(
      bridge.onOpenFolderRequest(() => {
        if (this.active) void this.openFolderDialog()
      })
    )
    keep(
      bridge.onShowShortcuts(() => {
        if (this.active) store.getState().setShortcutsOpen(true)
      })
    )
    keep(bridge.onMenuUndo(() => this.routeMenuHistory(false)))
    keep(bridge.onMenuRedo(() => this.routeMenuHistory(true)))
    keep(
      bridge.onScanFolderProgress((token, root, files) => {
        if (this.active) this.coordinator?.onScanBatch(token, root, files)
      })
    )
    keep(
      bridge.onCloseRequested(() => {
        if (!this.active) return
        if (this.confirmDiscard()) bridge.confirmClose()
        else bridge.cancelClose()
      })
    )
  }

  private routeMenuHistory(redo: boolean): void {
    if (!this.active) return
    const state = this.deps.store.getState()
    const target = menuHistoryTarget(state.shortcutsOpen, this.deps.documentTarget.activeElement)
    if (target === 'blocked') return
    if (target === 'text') {
      this.deps.documentTarget.execCommand(redo ? 'redo' : 'undo')
    } else if (redo) {
      state.redo()
    } else {
      state.undo()
    }
  }

  private registerWindowEvents(): void {
    this.addWindowListener('keydown', (rawEvent) => this.onKeyDown(rawEvent as KeyboardEvent))
    this.addWindowListener('dragenter', (rawEvent) => this.onDragEnter(rawEvent as DragEvent))
    this.addWindowListener('dragleave', () => this.onDragLeave())
    this.addWindowListener('dragover', (rawEvent) => this.onDragOver(rawEvent as DragEvent))
    this.addWindowListener('drop', (rawEvent) => this.onDrop(rawEvent as DragEvent))
  }

  private addWindowListener(type: string, listener: EventListener): void {
    this.windowListeners.push([type, listener])
    this.deps.windowTarget.addEventListener(type, listener)
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (!this.active) return
    const state = this.deps.store.getState()
    const command = keyCommand(event, {
      hasRegionBox: state.segBox !== null,
      maximizedView: state.maximizedView !== null,
      folderOpen: state.folder !== null,
      shortcutsOpen: state.shortcutsOpen
    })
    if (!command) return

    switch (command) {
      case 'cancel-region':
        state.cancelSeg()
        break
      case 'restore-view':
        if (state.maximizedView !== null) state.toggleMaximized(state.maximizedView)
        break
      case 'commit-region':
        state.commitPreview()
        break
      case 'shrink-brush':
        state.setBrushRadius(state.brushRadius - 1)
        break
      case 'grow-brush':
        state.setBrushRadius(state.brushRadius + 1)
        break
      case 'show-shortcuts':
        state.setShortcutsOpen(true)
        break
      case 'undo':
        state.undo()
        break
      case 'redo':
        state.redo()
        break
      case 'previous-file':
        this.coordinator?.navigate(-1)
        break
      case 'next-file':
        this.coordinator?.navigate(1)
        break
    }
    event.preventDefault()
  }

  private onDragEnter(event: DragEvent): void {
    if (!this.active || !event.dataTransfer?.types.includes('Files')) return
    this.dragDepth++
    this.setUiState({ dragging: true })
  }

  private onDragLeave(): void {
    if (!this.active) return
    this.dragDepth = Math.max(0, this.dragDepth - 1)
    if (this.dragDepth === 0) this.setUiState({ dragging: false })
  }

  private onDragOver(event: DragEvent): void {
    if (!this.active) return
    event.preventDefault()
    this.setUiState({ dropTarget: dropTargetAt(event.target) })
  }

  private onDrop(event: DragEvent): void {
    if (!this.active) return
    event.preventDefault()
    this.dragDepth = 0
    this.setUiState({ dragging: false })
    const file = event.dataTransfer?.files[0]
    if (!file) return
    const target = dropTargetAt(event.target)
    const path = this.deps.bridge.pathForFile(file) || null
    const resolvedTarget: Exclude<LoadTarget, 'auto'> =
      target === 'auto' ? (this.deps.store.getState().volume ? 'overlay' : 'base') : target
    void this.handleDrop(file, path, resolvedTarget)
  }

  private async handleDrop(
    file: File,
    path: string | null,
    target: Exclude<LoadTarget, 'auto'>
  ): Promise<void> {
    if (path) {
      const isDirectory = await this.deps.bridge.isDirectory(path).catch(() => false)
      if (!this.active) return
      if (isDirectory) {
        try {
          const scanned = await this.coordinator?.scanFolder((token) =>
            this.deps.bridge.scanDroppedFolder(file, token)
          )
          if (!this.active || scanned) return
        } catch (error) {
          if (this.active) this.deps.store.getState().fail(ipcErrorMessage(error))
          return
        }
      }
    }
    if (!acceptsVolumeFileName(file.name)) {
      this.deps.store.getState().fail(`"${file.name}" is not a .nii or .nii.gz file.`)
      return
    }
    if (file.size > (this.deps.maxBytes ?? MAX_BYTES)) {
      this.deps.store.getState().fail('File is larger than 2 GB, which is not supported.')
      return
    }
    try {
      const bytes = await file.arrayBuffer()
      if (!this.active) return
      if (target === 'base') await this.coordinator?.openBase(file.name, bytes, path)
      else await this.coordinator?.openOverlay(file.name, bytes)
    } catch (error) {
      if (this.active) this.deps.store.getState().fail(ipcErrorMessage(error))
    }
  }

  private setUiState(patch: Partial<RuntimeUiState>): void {
    const next = { ...this.uiState, ...patch }
    if (next.dragging === this.uiState.dragging && next.dropTarget === this.uiState.dropTarget)
      return
    this.uiState = next
    for (const listener of this.uiListeners) listener()
  }
}

export function createRendererRuntime(deps: RendererRuntimeDeps): RendererRuntime {
  return new OwnedRendererRuntime(deps)
}
