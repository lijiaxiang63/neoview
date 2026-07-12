import type {
  FolderEntry,
  FolderScan,
  OpenedFile,
  OpenedLayer,
  OpenedLayerTable,
  ViewMenuState
} from '../../../shared/files'
import type { OpenIntentGate } from '../../../shared/openIntents'
import type { AppState, AppStore } from '../store'
import { MAX_BYTES } from '../volume/gunzip'
import type { Volume } from '../volume/types'
import { releaseFrameTextureSource } from '../volume/loadVolume'
import {
  LoadCoordinator,
  type CoordinatorEffects,
  type OverlayLoadMetadata,
  type ScanResult
} from '../files/loadCoordinator'
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
import { layerTableKey, parseLayerLabelTable, type LayerLabelTable } from '../slicing/labelTable'
import type { LayerTableSource } from '../slicing/overlay'
import type { AppSettings } from '../../../shared/settings'

export interface RendererBridge {
  platform: string
  openDialog(baseIntent: number): Promise<OpenedFile | null>
  openOverlayDialog(requestId: number, currentFilePath: string | null): Promise<OpenedLayer | null>
  openLayerTable(
    requestId: number,
    currentFilePath: string | null
  ): Promise<OpenedLayerTable | null>
  readBuiltInLayerTable(requestId: number): Promise<OpenedLayerTable | null>
  beginBaseIntent(): Promise<number>
  acceptBaseIntent(intent: number): void
  onFileOpened(callback: (intent: number, file: OpenedFile) => void): () => void
  onOverlayOpenStarted(callback: (openId: number) => void): () => void
  onOverlayOpened(callback: (openId: number, file: OpenedFile) => void): () => void
  onOverlayOpenError(callback: (openId: number, message: string) => void): () => void
  onFileOpenError(callback: (message: string, intent?: number) => void): () => void
  onOpenFolderRequest(callback: () => void): () => void
  onAddLayerRequest(callback: () => void): () => void
  onShowShortcuts(callback: () => void): () => void
  onMenuUndo(callback: () => void): () => void
  onMenuRedo(callback: () => void): () => void
  onScanFolderProgress(
    callback: (token: number, root: string, files: FolderEntry[]) => void
  ): () => void
  onCloseRequested(callback: (requestId: number, responderLease: number) => void): () => void
  onToggleFilePanel(callback: () => void): () => void
  onToggleSidePanel(callback: () => void): () => void
  onToggleDirectionLabels(callback: () => void): () => void
  onToggleCrosshair(callback: () => void): () => void
  getAppSettings(): Promise<AppSettings>
  onAppSettingsChanged(callback: (settings: AppSettings) => void): () => void
  openFolderScan(token: number): Promise<FolderScan | null>
  scanDroppedFolder(file: File, token: number): Promise<FolderScan | null>
  isDirectory(path: string): Promise<boolean>
  pathForFile(file: File): string
  readFile(path: string, requestId: number): Promise<OpenedFile>
  readFileWithin(path: string, maxBytes: number, requestId: number): Promise<OpenedFile | null>
  cancelFileRead(requestId: number): void
  noteFileOpened(path: string): void
  sendViewState(state: ViewMenuState): void
  confirmFolderScan(token: number): void
  cancelFolderScan(token: number): void
  releaseFolderAccess(): void
  claimCloseResponder(): Promise<number>
  activateCloseResponder(lease: number): void
  releaseCloseResponder(lease: number): void
  confirmClose(requestId: number, lease: number): void
  cancelClose(requestId: number, lease: number): void
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
  openBase(name: string, bytes: ArrayBuffer, path: string | null, intent?: number): Promise<void>
  reportBaseError(error: unknown, intent?: number): void
  openOverlay(name: string, bytes: ArrayBuffer, metadata?: OverlayLoadMetadata): Promise<void>
  requestEntry(path: string, intent?: number): void
  navigate(delta: 1 | -1, intent?: number): void
  scanFolder(scan: (token: number) => Promise<ScanResult | null>, intent?: number): Promise<boolean>
  onScanBatch(token: number, root: string, files: FolderEntry[]): void
  releasePrefetch(): void
  dispose(): void
}

export type RuntimeCoordinatorFactory<V> = (
  effects: CoordinatorEffects<V>,
  options: {
    deferAutoLoad(entry: FolderEntry): boolean
    intentGate: OpenIntentGate
    onIntentAccepted(token: number): void
  }
) => RuntimeCoordinator

export interface RendererRuntimeDeps {
  store: Pick<AppStore, 'getState' | 'subscribe' | 'openIntentGate'>
  bridge: RendererBridge
  windowTarget: RuntimeEventTarget
  documentTarget: RuntimeDocument
  loadVolume(
    name: string,
    bytes: ArrayBuffer,
    options?: { skipTex?: true; signal?: AbortSignal }
  ): Promise<Volume>
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
  chooseOverlayTable(id: number): Promise<void>
  useBuiltInOverlayTable(id: number): Promise<void>
  selectOverlayTableSource(id: number, source: LayerTableSource): void
  openFolderDialog(): Promise<void>
  requestEntry(path: string): void
  subscribeUi(listener: () => void): () => void
  getUiSnapshot(): RuntimeUiState
}

const INITIAL_UI: RuntimeUiState = { dragging: false, dropTarget: 'auto' }
let nextFileReadRequestId = 0
const LAYER_TABLE_MAX_BYTES = 8 * 1024 * 1024

function cancelledFileRead(): Error {
  const error = new Error('File read cancelled.')
  error.name = 'AbortError'
  return error
}

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
  private lastViewState: ViewMenuState | null = null
  private lastTitle: string | null = null
  private closeResponderLease: number | null = null
  private closeResponderClaim: Promise<number> | null = null
  private readonly mainOverlaySessions = new Map<number, number | null>()
  private readonly overlayDialogReads = new Set<number>()
  private readonly overlayTableReadGeneration = new Map<number, number>()
  private readonly overlayTableReadRequest = new Map<number, number>()

  constructor(private readonly deps: RendererRuntimeDeps) {
    this.platform = deps.bridge.platform
  }

  init(): void {
    if (this.active || this.disposed) return
    const createCoordinator =
      this.deps.createCoordinator ??
      ((effects, options): RuntimeCoordinator => new LoadCoordinator<Volume>(effects, options))
    this.coordinator = createCoordinator(this.coordinatorEffects(), {
      deferAutoLoad: (entry) => regionExportSource(entry.name) !== null,
      intentGate: this.deps.store.openIntentGate,
      onIntentAccepted: (token) => {
        try {
          this.deps.bridge.acceptBaseIntent(token)
        } catch {
          // Renderer ordering remains authoritative; sender teardown will
          // cancel main-side work if this best-effort promotion cannot send.
        }
      }
    })
    this.active = true
    try {
      this.registerStoreBridge()
      this.registerIpcBridge()
      this.registerWindowEvents()
      this.claimCloseResponder()
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

    this.cancelOverlayDialogReads()

    const lease = this.closeResponderLease
    this.closeResponderLease = null
    this.closeResponderClaim = null
    if (lease !== null) this.releaseCloseResponder(lease)

    for (const unsubscribe of this.ipcUnsubscribes.splice(0).reverse()) unsubscribe()
    for (const [type, listener] of this.windowListeners.splice(0).reverse()) {
      this.deps.windowTarget.removeEventListener(type, listener)
    }
    this.storeUnsubscribe?.()
    this.storeUnsubscribe = null

    this.coordinator?.dispose()
    this.coordinator = null
    this.mainOverlaySessions.clear()
    this.dragDepth = 0
    this.uiState = INITIAL_UI
    this.uiListeners.clear()
    this.lastViewState = null
    this.lastTitle = null
  }

  openFileDialog = async (): Promise<void> => {
    if (!this.active) return
    let intent: number | undefined
    try {
      // Reserve ordering before the native picker starts. If the picker is
      // cancelled the token never reaches the coordinator and changes nothing.
      intent = await this.deps.bridge.beginBaseIntent()
      if (!this.active) return
      const opened = await this.deps.bridge.openDialog(intent)
      if (!this.active || !opened) return
      await this.coordinator?.openBase(opened.name, opened.bytes, opened.path, intent)
    } catch (error) {
      if (this.active) this.coordinator?.reportBaseError(error, intent)
    }
  }

  addOverlayDialog = async (): Promise<void> => {
    if (!this.active) return
    const ownerSession = this.overlaySession()
    const requestId = ++nextFileReadRequestId
    this.overlayDialogReads.add(requestId)
    try {
      const opened = await this.deps.bridge.openOverlayDialog(
        requestId,
        this.deps.store.getState().sourcePath
      )
      if (!this.active || !opened || !this.overlaySessionIsCurrent(ownerSession)) return
      if (opened.kind === 'table') {
        this.attachLayerTable(opened.table.path, opened.table.text)
        return
      }
      const parsed = opened.table ? parseLayerLabelTable(opened.table.text) : null
      if (opened.tableError || (parsed && !parsed.table)) {
        this.deps.store.getState().pushToast({
          text: opened.tableError ?? 'The adjacent layer table has no valid entries.',
          variant: 'error'
        })
      } else if (parsed && parsed.invalidLines > 0) {
        this.deps.store.getState().pushToast({
          text: `Ignored ${parsed.invalidLines} invalid layer table line${parsed.invalidLines === 1 ? '' : 's'}.`
        })
      }
      await this.coordinator?.openOverlay(opened.file.name, opened.file.bytes, {
        sourcePath: opened.file.path,
        labelTable: parsed?.table ?? null,
        labelTableName: opened.table?.name ?? null
      })
    } catch (error) {
      if (this.active && this.overlaySessionIsCurrent(ownerSession)) {
        this.deps.store.getState().fail(ipcErrorMessage(error))
      }
    } finally {
      this.overlayDialogReads.delete(requestId)
    }
  }

  chooseOverlayTable = async (id: number): Promise<void> => {
    await this.readOverlayTable(id, 'custom')
  }

  useBuiltInOverlayTable = async (id: number): Promise<void> => {
    await this.readOverlayTable(id, 'built-in')
  }

  selectOverlayTableSource = (id: number, source: LayerTableSource): void => {
    if (!this.active) return
    const layer = this.deps.store.getState().overlays.find((candidate) => candidate.id === id)
    if (layer?.kind !== 'labels') return
    this.invalidateOverlayTableRead(id)
    this.deps.store.getState().selectOverlayTableSource(id, source)
  }

  private invalidateOverlayTableRead(id: number): number {
    const requestId = this.overlayTableReadRequest.get(id)
    if (requestId !== undefined) {
      try {
        this.deps.bridge.cancelFileRead(requestId)
      } catch {
        // A replaced document also releases the main-side request owner.
      }
      this.overlayTableReadRequest.delete(id)
    }
    const generation = (this.overlayTableReadGeneration.get(id) ?? 0) + 1
    this.overlayTableReadGeneration.set(id, generation)
    return generation
  }

  private async readOverlayTable(id: number, source: 'built-in' | 'custom'): Promise<void> {
    if (!this.active) return
    const stateAtStart = this.deps.store.getState()
    if (!stateAtStart.overlays.some((layer) => layer.id === id && layer.kind === 'labels')) return
    const generation = this.invalidateOverlayTableRead(id)
    const ownerSession = this.overlaySession()
    const requestId = ++nextFileReadRequestId
    this.overlayDialogReads.add(requestId)
    this.overlayTableReadRequest.set(id, requestId)
    const ownsRead = (): boolean => {
      const layer = this.deps.store.getState().overlays.find((candidate) => candidate.id === id)
      return (
        layer?.kind === 'labels' &&
        this.overlayTableReadGeneration.get(id) === generation &&
        this.overlayTableReadRequest.get(id) === requestId
      )
    }
    try {
      const opened =
        source === 'built-in'
          ? await this.deps.bridge.readBuiltInLayerTable(requestId)
          : await this.deps.bridge.openLayerTable(requestId, stateAtStart.sourcePath)
      if (!this.active || !opened || !this.overlaySessionIsCurrent(ownerSession) || !ownsRead()) {
        return
      }
      const parsed = parseLayerLabelTable(opened.text)
      const state = this.deps.store.getState()
      if (!parsed.table) {
        state.fail('The selected color table has no valid entries.')
        return
      }
      if (
        !state.setOverlayTableOption(id, source, {
          name: source === 'built-in' ? 'FreeSurfer' : opened.name,
          table: parsed.table
        })
      ) {
        return
      }
      state.pushToast({
        text: `Applied ${parsed.table.size} names and colors.`,
        variant: 'success'
      })
      if (parsed.invalidLines > 0) {
        state.pushToast({
          text: `Ignored ${parsed.invalidLines} invalid color table line${parsed.invalidLines === 1 ? '' : 's'}.`
        })
      }
    } catch (error) {
      if (this.active && this.overlaySessionIsCurrent(ownerSession) && ownsRead()) {
        this.deps.store.getState().fail(ipcErrorMessage(error))
      }
    } finally {
      this.overlayDialogReads.delete(requestId)
      if (this.overlayTableReadRequest.get(id) === requestId) {
        this.overlayTableReadRequest.delete(id)
      }
    }
  }

  private attachLayerTable(sourcePath: string, text: string): void {
    const parsed = parseLayerLabelTable(text)
    const state = this.deps.store.getState()
    if (!parsed.table) {
      state.fail('The selected layer table has no valid entries.')
      return
    }
    const result = state.attachOverlayTable(sourcePath, parsed.table, this.platform === 'win32')
    if (result === 'missing') {
      state.fail('Import the matching layer data before attaching its table.')
      return
    }
    if (result === 'ambiguous') {
      state.fail('More than one layer matches this table. Remove the duplicate and try again.')
      return
    }
    state.pushToast({
      text: `Applied ${parsed.table.size} names and colors.`,
      variant: 'success'
    })
    if (parsed.invalidLines > 0) {
      state.pushToast({
        text: `Ignored ${parsed.invalidLines} invalid layer table line${parsed.invalidLines === 1 ? '' : 's'}.`
      })
    }
  }

  openFolderDialog = async (): Promise<void> => {
    if (!this.active || this.folderFlowActive || this.deps.store.getState().folderLoading) return
    this.folderFlowActive = true
    let intent: number | undefined
    try {
      intent = await this.deps.bridge.beginBaseIntent()
      if (!this.active) return
      await this.coordinator?.scanFolder((token) => this.deps.bridge.openFolderScan(token), intent)
    } catch (error) {
      // scanFolder accepts a terminal failure before rethrowing it. Recheck
      // the same token here because a newer intent can start in the microtask
      // gap between the inner rejection and this outer continuation.
      if (this.active) this.coordinator?.reportBaseError(error, intent)
    } finally {
      this.folderFlowActive = false
    }
  }

  requestEntry = (path: string): void => {
    this.withBaseIntent((intent) => this.coordinator?.requestEntry(path, intent))
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
      read: (path, signal) =>
        this.readWithCancellation(signal, (requestId) => bridge.readFile(path, requestId)),
      readWithin: (path, maxBytes, signal) =>
        this.readWithCancellation(signal, (requestId) =>
          bridge.readFileWithin(path, maxBytes, requestId)
        ),
      parseBase: (name, bytes, signal) => this.deps.loadVolume(name, bytes, { signal }),
      releaseBase: (volume) => releaseFrameTextureSource(volume),
      commitBase: (volume, path) => {
        if (!this.active) return
        store.getState().setVolume(volume, path, false)
        if (path) bridge.noteFileOpened(path)
      },
      parseAndAddOverlay: async (name, bytes, metadata, isCurrent, signal) => {
        const base = store.getState().volume
        if (!base) throw new Error('Load the base volume first.')
        const volume = await this.deps.loadVolume(name, bytes, { skipTex: true, signal })
        if (!this.active || !isCurrent()) return
        const state = store.getState()
        if (state.volume !== base) {
          return
        } else if (!this.deps.volumesAlign(base, volume)) {
          throw new Error('Overlay could not be aligned: its affine is not invertible.')
        } else {
          state.addOverlay(volume, {
            settleLoad: false,
            sourcePath: metadata.sourcePath,
            labelTable: metadata.labelTable,
            labelTableName: metadata.labelTableName
          })
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

  private readWithCancellation<T>(
    signal: AbortSignal,
    start: (requestId: number) => Promise<T>
  ): Promise<T> {
    if (signal.aborted) return Promise.reject(cancelledFileRead())
    const requestId = ++nextFileReadRequestId
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        fn()
      }
      const onAbort = (): void => {
        try {
          this.deps.bridge.cancelFileRead(requestId)
        } catch {
          // Renderer ownership still settles immediately; main-side sender
          // teardown is the final cleanup backstop if IPC is already gone.
        }
        finish(() => reject(cancelledFileRead()))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      let pending: Promise<T>
      try {
        pending = start(requestId)
      } catch (error) {
        finish(() => reject(error))
        return
      }
      void pending.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error))
      )
    })
  }

  private registerStoreBridge(): void {
    const { store } = this.deps
    const initial = store.getState()
    this.syncStoreState(initial)
    this.storeUnsubscribe = store.subscribe((state, previous) => {
      if (!this.active) return
      if (state.volumeSession !== previous.volumeSession) this.cancelOverlayDialogReads()
      if (previous.folder !== null && state.folder === null) {
        this.coordinator?.releasePrefetch()
        this.deps.bridge.releaseFolderAccess()
      }
      this.syncStoreState(state)
    })
  }

  private syncStoreState(state: AppState): void {
    const title = state.volume ? `${state.volume.name} — Neoview` : 'Neoview'
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
      bridge.onToggleDirectionLabels(() => {
        if (this.active) store.getState().toggleDirectionLabels()
      })
    )
    keep(
      bridge.onToggleCrosshair(() => {
        if (this.active) store.getState().toggleCrosshair()
      })
    )
    keep(
      bridge.onFileOpened((intent, file) => {
        if (this.active)
          void this.coordinator?.openBase(file.name, file.bytes, file.path || null, intent)
      })
    )
    keep(
      bridge.onOverlayOpenStarted((openId) => {
        if (this.active && Number.isSafeInteger(openId) && openId > 0) {
          this.mainOverlaySessions.set(openId, this.overlaySession())
        }
      })
    )
    keep(
      bridge.onOverlayOpened((openId, file) => {
        if (!this.active || !this.mainOverlaySessions.has(openId)) return
        const ownerSession = this.mainOverlaySessions.get(openId) ?? null
        this.mainOverlaySessions.delete(openId)
        if (this.overlaySessionIsCurrent(ownerSession)) {
          void this.coordinator?.openOverlay(file.name, file.bytes)
        }
      })
    )
    keep(
      bridge.onOverlayOpenError((openId, message) => {
        if (!this.active || !this.mainOverlaySessions.has(openId)) return
        const ownerSession = this.mainOverlaySessions.get(openId) ?? null
        this.mainOverlaySessions.delete(openId)
        if (this.overlaySessionIsCurrent(ownerSession)) {
          store.getState().fail(message)
        }
      })
    )
    keep(
      bridge.onFileOpenError((message, intent) => {
        if (this.active) this.coordinator?.reportBaseError(message, intent)
      })
    )
    keep(
      bridge.onOpenFolderRequest(() => {
        if (this.active) void this.openFolderDialog()
      })
    )
    keep(
      bridge.onAddLayerRequest(() => {
        if (this.active && store.getState().volume) void this.addOverlayDialog()
      })
    )
    keep(
      bridge.onShowShortcuts(() => {
        if (this.active) store.getState().setShortcutsOpen(true)
      })
    )
    // Subscribe before the initial query so a write from the settings window
    // cannot slip between them unseen; snapshots are idempotent to reapply.
    keep(
      bridge.onAppSettingsChanged((settings) => {
        if (this.active) store.getState().applyAppSettings(settings)
      })
    )
    void bridge
      .getAppSettings()
      .then((settings) => {
        if (this.active) store.getState().applyAppSettings(settings)
      })
      .catch(() => {
        // Defaults remain in effect when the initial query cannot resolve.
      })
    keep(bridge.onMenuUndo(() => this.routeMenuHistory(false)))
    keep(bridge.onMenuRedo(() => this.routeMenuHistory(true)))
    keep(
      bridge.onScanFolderProgress((token, root, files) => {
        if (this.active) this.coordinator?.onScanBatch(token, root, files)
      })
    )
    keep(
      bridge.onCloseRequested((requestId, responderLease) => {
        if (!this.active) return
        const lease = this.closeResponderLease
        if (lease === null || responderLease !== lease) return
        if (this.confirmDiscard()) bridge.confirmClose(requestId, lease)
        else bridge.cancelClose(requestId, lease)
      })
    )
  }

  private claimCloseResponder(): void {
    let claim: Promise<number>
    try {
      claim = this.deps.bridge.claimCloseResponder()
    } catch {
      return
    }
    this.closeResponderClaim = claim
    void claim.then(
      (lease) => {
        if (this.closeResponderClaim !== claim || !this.active || this.disposed) {
          this.releaseCloseResponder(lease)
          return
        }
        this.closeResponderClaim = null
        this.closeResponderLease = lease
        try {
          this.deps.bridge.activateCloseResponder(lease)
        } catch {
          // Navigation/process teardown can close IPC between claim and
          // activation. The stored lease is still released during dispose.
        }
      },
      () => {
        if (this.closeResponderClaim === claim) this.closeResponderClaim = null
      }
    )
  }

  private releaseCloseResponder(lease: number): void {
    try {
      this.deps.bridge.releaseCloseResponder(lease)
    } catch {
      // Sender teardown is also a main-side lease-release boundary. Never let
      // a best-effort send interrupt the rest of runtime disposal.
    }
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
    const command = keyCommand(
      event,
      {
        hasRegionBox: state.segBox !== null,
        maximizedView: state.maximizedView !== null,
        folderOpen: state.folder !== null,
        shortcutsOpen: state.shortcutsOpen,
        hasVolume: state.volume !== null
      },
      this.platform
    )
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
      case 'add-layer':
        void this.addOverlayDialog()
        break
      case 'undo':
        state.undo()
        break
      case 'redo':
        state.redo()
        break
      case 'previous-file':
        this.withBaseIntent((intent) => this.coordinator?.navigate(-1, intent))
        break
      case 'next-file':
        this.withBaseIntent((intent) => this.coordinator?.navigate(1, intent))
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
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length === 0) return
    const target = dropTargetAt(event.target)
    const resolvedTarget: Exclude<LoadTarget, 'auto'> =
      target === 'auto' ? (this.deps.store.getState().volume ? 'overlay' : 'base') : target
    const file =
      resolvedTarget === 'overlay'
        ? (files.find((candidate) => acceptsVolumeFileName(candidate.name)) ?? files[0])
        : files[0]
    const path = this.deps.bridge.pathForFile(file) || null
    const caseInsensitive = this.platform === 'win32'
    const fileKey = layerTableKey(path ?? file.name, caseInsensitive)
    const tableFile = files.find((candidate) => {
      if (!candidate.name.toLowerCase().endsWith('.txt')) return false
      const candidatePath = this.deps.bridge.pathForFile(candidate) || candidate.name
      return layerTableKey(candidatePath, caseInsensitive) === fileKey
    })
    const intent = this.deps.bridge.beginBaseIntent()
    const overlaySession = resolvedTarget === 'overlay' ? this.overlaySession() : null
    void this.handleDrop(file, path, tableFile ?? null, resolvedTarget, intent, overlaySession)
  }

  private async handleDrop(
    file: File,
    path: string | null,
    tableFile: File | null,
    target: Exclude<LoadTarget, 'auto'>,
    intentPromise: Promise<number>,
    overlaySession: number | null
  ): Promise<void> {
    let intent: number | undefined
    try {
      const result = await Promise.all([
        intentPromise,
        path ? this.deps.bridge.isDirectory(path).catch(() => false) : Promise.resolve(false)
      ])
      intent = result[0]
      const isDirectory = result[1]
      if (!this.active) return
      // A newer accepted base action may have won while the path probe was
      // pending. Do not start a potentially huge browser-side read for an
      // intent the store-lifetime gate will necessarily reject.
      if (target === 'base' && intent < this.deps.store.openIntentGate.current()) return
      if (isDirectory) {
        try {
          const scanned = await this.coordinator?.scanFolder(
            (token) => this.deps.bridge.scanDroppedFolder(file, token),
            intent
          )
          if (!this.active || scanned) return
        } catch (error) {
          if (this.active) this.coordinator?.reportBaseError(error, intent)
          return
        }
      }
      if (target === 'overlay' && !this.overlaySessionIsCurrent(overlaySession)) return
      if (target === 'overlay' && file.name.toLowerCase().endsWith('.txt')) {
        if (file.size > LAYER_TABLE_MAX_BYTES) {
          this.deps.store
            .getState()
            .fail('Layer table is larger than 8 MB, which is not supported.')
          return
        }
        const text = await file.text()
        if (!this.active || !this.overlaySessionIsCurrent(overlaySession)) return
        this.attachLayerTable(path ?? file.name, text)
        return
      }
      if (!acceptsVolumeFileName(file.name)) {
        const error = `"${file.name}" is not a .nii or .nii.gz file.`
        if (target === 'base') this.coordinator?.reportBaseError(error, intent)
        else this.deps.store.getState().fail(error)
        return
      }
      if (file.size > (this.deps.maxBytes ?? MAX_BYTES)) {
        const error = 'File is larger than 2 GB, which is not supported.'
        if (target === 'base') this.coordinator?.reportBaseError(error, intent)
        else this.deps.store.getState().fail(error)
        return
      }
      const bytes = await file.arrayBuffer()
      if (!this.active) return
      if (target === 'overlay' && !this.overlaySessionIsCurrent(overlaySession)) return
      if (target === 'base') await this.coordinator?.openBase(file.name, bytes, path, intent)
      else {
        let labelTable: LayerLabelTable | null = null
        if (tableFile) {
          if (tableFile.size > LAYER_TABLE_MAX_BYTES) {
            this.deps.store.getState().pushToast({
              text: 'The paired layer table is larger than 8 MB and was ignored.',
              variant: 'error'
            })
          } else {
            const text = await tableFile.text()
            if (!this.active || !this.overlaySessionIsCurrent(overlaySession)) return
            const parsed = parseLayerLabelTable(text)
            labelTable = parsed.table
            if (!parsed.table) {
              this.deps.store.getState().pushToast({
                text: 'The paired layer table has no valid entries.',
                variant: 'error'
              })
            } else if (parsed.invalidLines > 0) {
              this.deps.store.getState().pushToast({
                text: `Ignored ${parsed.invalidLines} invalid layer table line${parsed.invalidLines === 1 ? '' : 's'}.`
              })
            }
          }
        }
        await this.coordinator?.openOverlay(file.name, bytes, {
          sourcePath: path,
          labelTable,
          labelTableName: labelTable ? (tableFile?.name ?? null) : null
        })
      }
    } catch (error) {
      if (!this.active) return
      if (target === 'base') this.coordinator?.reportBaseError(error, intent)
      else if (this.overlaySessionIsCurrent(overlaySession)) {
        this.deps.store.getState().fail(ipcErrorMessage(error))
      }
    }
  }

  private overlaySession(): number | null {
    const state = this.deps.store.getState()
    return state.volume ? state.volumeSession : null
  }

  private overlaySessionIsCurrent(ownerSession: number | null): boolean {
    const state = this.deps.store.getState()
    return ownerSession === null
      ? state.volume === null
      : state.volume !== null && state.volumeSession === ownerSession
  }

  private cancelOverlayDialogReads(): void {
    for (const requestId of this.overlayDialogReads) {
      try {
        this.deps.bridge.cancelFileRead(requestId)
      } catch {
        // Main-frame navigation/process teardown is the final cancellation
        // backstop if this sender can no longer deliver IPC.
      }
    }
    this.overlayDialogReads.clear()
    this.overlayTableReadRequest.clear()
  }

  private withBaseIntent(action: (intent: number) => void): void {
    if (!this.active) return
    void this.deps.bridge
      .beginBaseIntent()
      .then((intent) => {
        if (this.active) action(intent)
      })
      .catch((error) => {
        if (this.active) this.deps.store.getState().fail(ipcErrorMessage(error))
      })
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
