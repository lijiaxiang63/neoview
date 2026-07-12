import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppStore, type AppStore, type PreviewController } from '../src/renderer/src/store'
import type { Volume } from '../src/renderer/src/volume/types'
import type { FolderScan, OpenedFile, OpenedLayer, OpenedLayerTable } from '../src/shared/files'
import {
  createRendererRuntime,
  type RendererBridge,
  type RendererRuntime,
  type RendererRuntimeDeps,
  type RuntimeCoordinator,
  type RuntimeDocument,
  type RuntimeEventTarget
} from '../src/renderer/src/runtime/rendererRuntime'
import { defaultAppSettings } from '../src/shared/settings'

type Callback = (...args: unknown[]) => void

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const bytes = (): ArrayBuffer => new ArrayBuffer(8)

function volume(name = 'base.nii'): Volume {
  return {
    name,
    dims: [1, 1, 1],
    frames: 1,
    datatypeCode: 2,
    slope: 1,
    inter: 0,
    affine: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    stats: {
      dataMin: 0,
      dataMax: 1,
      p2: 0,
      p98: 1,
      typeRange: [0, 255]
    }
  } as Volume
}

function opened(name = 'a.nii', path = '/x/a.nii'): OpenedFile {
  return { name, path, bytes: bytes() }
}

function scan(root = '/folder'): FolderScan {
  return {
    root,
    files: [{ name: 'a.nii', path: `${root}/a.nii`, relDir: '' }],
    truncated: false
  }
}

function previewController(): PreviewController {
  return {
    available: () => false,
    reset: vi.fn(),
    dropOverlay: vi.fn(),
    request: (() => false) as PreviewController['request'],
    dispose: vi.fn()
  }
}

interface BridgeHarness {
  bridge: RendererBridge
  emit(name: string, ...args: unknown[]): void
  listenerCount(name: string): number
  unsubscribes: Array<ReturnType<typeof vi.fn>>
  openDialog: ReturnType<typeof vi.fn<RendererBridge['openDialog']>>
  openOverlayDialog: ReturnType<typeof vi.fn<RendererBridge['openOverlayDialog']>>
  openLayerTable: ReturnType<typeof vi.fn<RendererBridge['openLayerTable']>>
  readBuiltInLayerTable: ReturnType<typeof vi.fn<RendererBridge['readBuiltInLayerTable']>>
  beginBaseIntent: ReturnType<typeof vi.fn<RendererBridge['beginBaseIntent']>>
  acceptBaseIntent: ReturnType<typeof vi.fn<RendererBridge['acceptBaseIntent']>>
  openFolderScan: ReturnType<typeof vi.fn<RendererBridge['openFolderScan']>>
  scanDroppedFolder: ReturnType<typeof vi.fn<RendererBridge['scanDroppedFolder']>>
  isDirectory: ReturnType<typeof vi.fn<RendererBridge['isDirectory']>>
  pathForFile: ReturnType<typeof vi.fn<RendererBridge['pathForFile']>>
  readFile: ReturnType<typeof vi.fn<RendererBridge['readFile']>>
  readFileWithin: ReturnType<typeof vi.fn<RendererBridge['readFileWithin']>>
  cancelFileRead: ReturnType<typeof vi.fn<RendererBridge['cancelFileRead']>>
  sendViewState: ReturnType<typeof vi.fn<RendererBridge['sendViewState']>>
  releaseFolderAccess: ReturnType<typeof vi.fn<RendererBridge['releaseFolderAccess']>>
  confirmClose: ReturnType<typeof vi.fn<RendererBridge['confirmClose']>>
  cancelClose: ReturnType<typeof vi.fn<RendererBridge['cancelClose']>>
  claimCloseResponder: ReturnType<typeof vi.fn<RendererBridge['claimCloseResponder']>>
  activateCloseResponder: ReturnType<typeof vi.fn<RendererBridge['activateCloseResponder']>>
  releaseCloseResponder: ReturnType<typeof vi.fn<RendererBridge['releaseCloseResponder']>>
  getAppSettings: ReturnType<typeof vi.fn<RendererBridge['getAppSettings']>>
}

function bridgeHarness(): BridgeHarness {
  const listeners = new Map<string, Set<Callback>>()
  const unsubscribes: Array<ReturnType<typeof vi.fn>> = []
  const listen = (name: string, callback: Callback): (() => void) => {
    const set = listeners.get(name) ?? new Set<Callback>()
    set.add(callback)
    listeners.set(name, set)
    const off = vi.fn(() => set.delete(callback))
    unsubscribes.push(off)
    return off
  }
  const openDialog = vi.fn<RendererBridge['openDialog']>(async () => null)
  const openOverlayDialog = vi.fn<RendererBridge['openOverlayDialog']>(async () => null)
  const openLayerTable = vi.fn<RendererBridge['openLayerTable']>(async () => null)
  const readBuiltInLayerTable = vi.fn<RendererBridge['readBuiltInLayerTable']>(async () => null)
  let nextIntent = 0
  const beginBaseIntent = vi.fn<RendererBridge['beginBaseIntent']>(async () => ++nextIntent)
  const acceptBaseIntent = vi.fn<RendererBridge['acceptBaseIntent']>()
  const openFolderScan = vi.fn<RendererBridge['openFolderScan']>(async () => null)
  const scanDroppedFolder = vi.fn<RendererBridge['scanDroppedFolder']>(async () => null)
  const isDirectory = vi.fn<RendererBridge['isDirectory']>(async () => false)
  const pathForFile = vi.fn<RendererBridge['pathForFile']>(() => '')
  const readFile = vi.fn<RendererBridge['readFile']>(async (path) => ({ ...opened(), path }))
  const readFileWithin = vi.fn<RendererBridge['readFileWithin']>(async () => null)
  const cancelFileRead = vi.fn<RendererBridge['cancelFileRead']>()
  const sendViewState = vi.fn<RendererBridge['sendViewState']>()
  const releaseFolderAccess = vi.fn<RendererBridge['releaseFolderAccess']>()
  const confirmClose = vi.fn<RendererBridge['confirmClose']>()
  const cancelClose = vi.fn<RendererBridge['cancelClose']>()
  let nextCloseLease = 0
  const claimCloseResponder = vi.fn<RendererBridge['claimCloseResponder']>(
    async () => ++nextCloseLease
  )
  const activateCloseResponder = vi.fn<RendererBridge['activateCloseResponder']>()
  const releaseCloseResponder = vi.fn<RendererBridge['releaseCloseResponder']>()
  const getAppSettings = vi.fn<RendererBridge['getAppSettings']>(async () => defaultAppSettings())
  const bridge: RendererBridge = {
    platform: 'darwin',
    openDialog,
    openOverlayDialog,
    openLayerTable,
    readBuiltInLayerTable,
    beginBaseIntent,
    acceptBaseIntent,
    onFileOpened: (callback) => listen('file-opened', callback as Callback),
    onOverlayOpenStarted: (callback) => listen('overlay-started', callback as Callback),
    onOverlayOpened: (callback) => listen('overlay-opened', callback as Callback),
    onOverlayOpenError: (callback) => listen('overlay-error', callback as Callback),
    onFileOpenError: (callback) => listen('file-error', callback as Callback),
    onOpenFolderRequest: (callback) => listen('open-folder', callback as Callback),
    onAddLayerRequest: (callback) => listen('add-layer', callback as Callback),
    onShowShortcuts: (callback) => listen('show-shortcuts', callback as Callback),
    onMenuUndo: (callback) => listen('undo', callback as Callback),
    onMenuRedo: (callback) => listen('redo', callback as Callback),
    onScanFolderProgress: (callback) => listen('scan-progress', callback as Callback),
    onCloseRequested: (callback) => listen('close', callback as Callback),
    onToggleFilePanel: (callback) => listen('toggle-files', callback as Callback),
    onToggleSidePanel: (callback) => listen('toggle-side', callback as Callback),
    onToggleDirectionLabels: (callback) => listen('toggle-labels', callback as Callback),
    onToggleCrosshair: (callback) => listen('toggle-crosshair', callback as Callback),
    getAppSettings,
    onAppSettingsChanged: (callback) => listen('app-settings-changed', callback as Callback),
    openFolderScan,
    scanDroppedFolder,
    isDirectory,
    pathForFile,
    readFile,
    readFileWithin,
    cancelFileRead,
    noteFileOpened: vi.fn(),
    sendViewState,
    confirmFolderScan: vi.fn(),
    cancelFolderScan: vi.fn(),
    releaseFolderAccess,
    claimCloseResponder,
    activateCloseResponder,
    releaseCloseResponder,
    confirmClose,
    cancelClose
  }
  return {
    bridge,
    emit: (name, ...args) => {
      for (const callback of listeners.get(name) ?? []) callback(...args)
    },
    listenerCount: (name) => listeners.get(name)?.size ?? 0,
    unsubscribes,
    openDialog,
    openOverlayDialog,
    openLayerTable,
    readBuiltInLayerTable,
    beginBaseIntent,
    acceptBaseIntent,
    openFolderScan,
    scanDroppedFolder,
    isDirectory,
    pathForFile,
    readFile,
    readFileWithin,
    cancelFileRead,
    sendViewState,
    releaseFolderAccess,
    confirmClose,
    cancelClose,
    claimCloseResponder,
    activateCloseResponder,
    releaseCloseResponder,
    getAppSettings
  }
}

interface WindowHarness {
  target: RuntimeEventTarget
  dispatch(type: string, event: object): void
  listenerCount(type: string): number
  add: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

function windowHarness(): WindowHarness {
  const listeners = new Map<string, Set<EventListener>>()
  const add = vi.fn((type: string, listener: EventListener) => {
    const set = listeners.get(type) ?? new Set<EventListener>()
    set.add(listener)
    listeners.set(type, set)
  })
  const remove = vi.fn((type: string, listener: EventListener) =>
    listeners.get(type)?.delete(listener)
  )
  return {
    target: { addEventListener: add, removeEventListener: remove },
    dispatch: (type, event) => {
      for (const listener of listeners.get(type) ?? []) listener(event as Event)
    },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
    add,
    remove
  }
}

function coordinator(): RuntimeCoordinator {
  return {
    openBase: vi.fn(async () => {}),
    reportBaseError: vi.fn(),
    openOverlay: vi.fn(async () => {}),
    requestEntry: vi.fn(),
    navigate: vi.fn(),
    scanFolder: vi.fn(async (start) => (await start(1)) !== null),
    onScanBatch: vi.fn(),
    releasePrefetch: vi.fn(),
    dispose: vi.fn()
  }
}

interface RuntimeHarness {
  runtime: RendererRuntime
  store: AppStore
  bridge: BridgeHarness
  window: WindowHarness
  document: RuntimeDocument & { execCommand: ReturnType<typeof vi.fn> }
  ownedCoordinator: RuntimeCoordinator
  coordinatorFactory: ReturnType<typeof vi.fn>
  storeUnsubscribe: ReturnType<typeof vi.fn>
  confirm: ReturnType<typeof vi.fn<(message: string) => boolean>>
  deps: RendererRuntimeDeps
}

const stores: AppStore[] = []
const runtimes: RendererRuntime[] = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const store of stores.splice(0)) store.dispose()
})

function runtimeHarness(ownedCoordinator = coordinator()): RuntimeHarness {
  const store = createAppStore({
    storage: null,
    pagehideTarget: null,
    createPreviewController: previewController
  })
  stores.push(store)
  const bridge = bridgeHarness()
  const window = windowHarness()
  const document = {
    activeElement: null as unknown,
    title: '',
    execCommand: vi.fn(() => true)
  }
  const storeUnsubscribe = vi.fn()
  const storeApi = {
    getState: store.getState,
    openIntentGate: store.openIntentGate,
    subscribe: vi.fn(
      (
        listener: (
          state: ReturnType<AppStore['getState']>,
          previous: ReturnType<AppStore['getState']>
        ) => void
      ) => {
        const unsubscribe = store.subscribe(listener)
        return () => {
          storeUnsubscribe()
          unsubscribe()
        }
      }
    )
  }
  const coordinatorFactory = vi.fn(() => ownedCoordinator)
  const confirm = vi.fn(() => true)
  const deps: RendererRuntimeDeps = {
    store: storeApi,
    bridge: bridge.bridge,
    windowTarget: window.target,
    documentTarget: document,
    loadVolume: vi.fn(async (name) => volume(name)),
    volumesAlign: vi.fn(() => true),
    confirm,
    createCoordinator: coordinatorFactory
  }
  const runtime = createRendererRuntime(deps)
  runtimes.push(runtime)
  return {
    runtime,
    store,
    bridge,
    window,
    document,
    ownedCoordinator,
    coordinatorFactory,
    storeUnsubscribe,
    confirm,
    deps
  }
}

function dropFile(name = 'a.nii', size = 8): File {
  return {
    name,
    size,
    arrayBuffer: vi.fn(async () => bytes())
  } as unknown as File
}

function dragEvent(file?: File | File[], zone: 'base' | 'overlay' | 'auto' = 'auto'): object {
  return {
    dataTransfer: { types: ['Files'], files: file ? (Array.isArray(file) ? file : [file]) : [] },
    target: {
      closest: () => (zone === 'auto' ? null : { dataset: { dropTarget: zone } })
    },
    preventDefault: vi.fn()
  }
}

describe('renderer runtime lifecycle', () => {
  it('initializes once, owns every subscription and responder lease, and disposes repeatably', async () => {
    const h = runtimeHarness()
    h.runtime.init()
    h.runtime.init()
    await tick()

    expect(h.coordinatorFactory).toHaveBeenCalledTimes(1)
    expect(h.coordinatorFactory.mock.calls[0][1].intentGate).toBe(h.store.openIntentGate)
    expect(h.bridge.unsubscribes).toHaveLength(17)
    expect(h.window.add).toHaveBeenCalledTimes(5)
    expect(h.bridge.claimCloseResponder).toHaveBeenCalledTimes(1)
    expect(h.bridge.activateCloseResponder).toHaveBeenCalledWith(1)
    expect(h.bridge.sendViewState).toHaveBeenCalledTimes(1)
    expect(h.document.title).toBe('Neoview')
    h.store.setState({ volume: volume() })
    expect(h.document.title).toBe('base.nii — Neoview')

    h.runtime.dispose()
    h.runtime.dispose()
    expect(h.ownedCoordinator.dispose).toHaveBeenCalledTimes(1)
    expect(h.bridge.unsubscribes.every((off) => off.mock.calls.length === 1)).toBe(true)
    expect(h.window.remove).toHaveBeenCalledTimes(5)
    expect(h.storeUnsubscribe).toHaveBeenCalledTimes(1)
    expect(h.bridge.releaseCloseResponder).toHaveBeenCalledWith(1)
    expect(h.bridge.releaseCloseResponder).toHaveBeenCalledTimes(1)
  })

  it('mount, unmount, and mount again leaves only the new listeners and lease active', async () => {
    const h = runtimeHarness()
    h.runtime.init()
    await tick()
    h.runtime.dispose()

    const nextCoordinator = coordinator()
    const next = createRendererRuntime({ ...h.deps, createCoordinator: () => nextCoordinator })
    runtimes.push(next)
    next.init()
    await tick()

    expect(h.bridge.activateCloseResponder.mock.calls).toEqual([[1], [2]])
    expect(h.bridge.releaseCloseResponder).toHaveBeenCalledWith(1)

    for (const name of ['file-opened', 'overlay-opened', 'close', 'toggle-files']) {
      expect(h.bridge.listenerCount(name)).toBe(1)
    }
    for (const type of ['keydown', 'dragenter', 'dragleave', 'dragover', 'drop']) {
      expect(h.window.listenerCount(type)).toBe(1)
    }
    h.bridge.emit('file-opened', 1, opened())
    expect(h.ownedCoordinator.openBase).not.toHaveBeenCalled()
    expect(nextCoordinator.openBase).toHaveBeenCalledTimes(1)
  })

  it('releases a responder claim that resolves after runtime disposal', async () => {
    const h = runtimeHarness()
    const claim = deferred<number>()
    h.bridge.claimCloseResponder.mockReturnValueOnce(claim.promise)
    h.runtime.init()
    h.runtime.dispose()

    claim.resolve(9)
    await tick()
    expect(h.bridge.activateCloseResponder).not.toHaveBeenCalled()
    expect(h.bridge.releaseCloseResponder).toHaveBeenCalledWith(9)
  })

  it('continues disposal when responder activation or release IPC throws', async () => {
    const h = runtimeHarness()
    h.bridge.activateCloseResponder.mockImplementation(() => {
      throw new Error('sender gone')
    })
    h.bridge.releaseCloseResponder.mockImplementation(() => {
      throw new Error('sender gone')
    })
    h.runtime.init()
    await tick()

    expect(() => h.runtime.dispose()).not.toThrow()
    expect(h.ownedCoordinator.dispose).toHaveBeenCalledTimes(1)
    expect(h.bridge.unsubscribes.every((off) => off.mock.calls.length === 1)).toBe(true)
    expect(h.window.remove).toHaveBeenCalledTimes(5)
    expect(h.storeUnsubscribe).toHaveBeenCalledTimes(1)
    expect(h.bridge.releaseCloseResponder).toHaveBeenCalledWith(1)
  })

  it('absorbs a failed release for a responder claim that settles after disposal', async () => {
    const h = runtimeHarness()
    const claim = deferred<number>()
    h.bridge.claimCloseResponder.mockReturnValueOnce(claim.promise)
    h.bridge.releaseCloseResponder.mockImplementation(() => {
      throw new Error('sender gone')
    })
    h.runtime.init()
    h.runtime.dispose()

    claim.resolve(7)
    await tick()
    expect(h.bridge.releaseCloseResponder).toHaveBeenCalledWith(7)
  })

  it('folder close releases prefetch and main-side folder access', () => {
    const h = runtimeHarness()
    h.runtime.init()
    h.store.getState().setFolder(scan())
    expect(h.ownedCoordinator.releasePrefetch).not.toHaveBeenCalled()
    h.store.getState().closeFolder()
    expect(h.ownedCoordinator.releasePrefetch).toHaveBeenCalledTimes(1)
    expect(h.bridge.releaseFolderAccess).toHaveBeenCalledTimes(1)
  })

  it('deduplicates View menu snapshots while still tracking relevant changes', () => {
    const h = runtimeHarness()
    h.runtime.init()
    h.store.getState().setDensity(0.7)
    expect(h.bridge.sendViewState).toHaveBeenCalledTimes(1)
    h.store.getState().toggleFilePanel()
    expect(h.bridge.sendViewState).toHaveBeenLastCalledWith({
      hasVolume: false,
      fileList: false,
      sidePanel: true,
      folderOpen: false,
      directionLabels: true,
      crosshair: true
    })
    expect(h.bridge.sendViewState).toHaveBeenCalledTimes(2)
    h.bridge.emit('toggle-labels')
    expect(h.bridge.sendViewState).toHaveBeenLastCalledWith({
      hasVolume: false,
      fileList: false,
      sidePanel: true,
      folderOpen: false,
      directionLabels: false,
      crosshair: true
    })
    h.bridge.emit('toggle-crosshair')
    expect(h.bridge.sendViewState).toHaveBeenLastCalledWith({
      hasVolume: false,
      fileList: false,
      sidePanel: true,
      folderOpen: false,
      directionLabels: false,
      crosshair: false
    })
  })
})

describe('renderer runtime event routing', () => {
  it('routes file, overlay, error, scan batch, and panel IPC events', () => {
    const h = runtimeHarness()
    h.runtime.init()
    const file = opened('sample.nii', '')
    h.bridge.emit('file-opened', 7, file)
    h.bridge.emit('overlay-started', 4)
    h.bridge.emit('overlay-opened', 4, file)
    h.bridge.emit('file-error', 'Read failed', 6)
    h.bridge.emit('scan-progress', 3, '/r', scan('/r').files)
    h.bridge.emit('toggle-files')
    h.bridge.emit('toggle-side')
    h.bridge.emit('show-shortcuts')

    expect(h.ownedCoordinator.openBase).toHaveBeenCalledWith(file.name, file.bytes, null, 7)
    expect(h.ownedCoordinator.openOverlay).toHaveBeenCalledWith(file.name, file.bytes)
    expect(h.ownedCoordinator.onScanBatch).toHaveBeenCalledWith(3, '/r', scan('/r').files)
    expect(h.ownedCoordinator.reportBaseError).toHaveBeenCalledWith('Read failed', 6)
    expect(h.store.getState().filePanelOpen).toBe(false)
    expect(h.store.getState().sidePanelOpen).toBe(false)
    expect(h.store.getState().shortcutsOpen).toBe(true)
  })

  it('adopts the main-owned settings snapshot on init and on broadcasts', async () => {
    const h = runtimeHarness()
    h.bridge.getAppSettings.mockResolvedValueOnce({
      playbackFps: 20,
      seg: { connectivity: 6, slabDepth: 3, brushRadius: 7 },
      expandLabelLists: false,
      modelBackend: 'webgl'
    })
    h.runtime.init()
    await tick()
    expect(h.store.getState().playbackFps).toBe(20)
    expect(h.store.getState().expandLabelLists).toBe(false)
    expect(h.store.getState().segDefaults).toEqual({
      connectivity: 6,
      slabDepth: 3,
      brushRadius: 7
    })

    h.bridge.emit('app-settings-changed', {
      ...defaultAppSettings(),
      playbackFps: 12
    })
    expect(h.store.getState().playbackFps).toBe(12)
    expect(h.store.getState().segDefaults).toEqual(defaultAppSettings().seg)
  })

  it('ignores settings arriving after dispose', async () => {
    const h = runtimeHarness()
    const settled = deferred<Awaited<ReturnType<RendererBridge['getAppSettings']>>>()
    h.bridge.getAppSettings.mockReturnValueOnce(settled.promise)
    h.runtime.init()
    h.runtime.dispose()
    h.bridge.emit('app-settings-changed', { ...defaultAppSettings(), playbackFps: 25 })
    settled.resolve({ ...defaultAppSettings(), playbackFps: 25 })
    await tick()
    expect(h.store.getState().playbackFps).toBe(8)
  })

  it('routes explicit file and overlay dialogs through their distinct entries', async () => {
    const h = runtimeHarness()
    const file = opened()
    h.bridge.openDialog.mockResolvedValue(file)
    h.bridge.openOverlayDialog.mockResolvedValue({
      kind: 'volume',
      file,
      table: null,
      tableError: null
    })
    h.runtime.init()
    await h.runtime.openFileDialog()
    h.store.getState().setVolume(volume('base.nii'), file.path)
    await h.runtime.addOverlayDialog()
    expect(h.ownedCoordinator.openBase).toHaveBeenCalledWith(file.name, file.bytes, file.path, 1)
    expect(h.bridge.openOverlayDialog).toHaveBeenCalledWith(expect.any(Number), file.path)
    expect(h.ownedCoordinator.openOverlay).toHaveBeenCalledWith(file.name, file.bytes, {
      sourcePath: file.path,
      labelTable: null,
      labelTableName: null
    })
  })

  it('passes an automatically matched table into the layer load', async () => {
    const h = runtimeHarness()
    const file = opened('result.regions-2.nii.gz')
    h.bridge.openOverlayDialog.mockResolvedValue({
      kind: 'volume',
      file,
      table: {
        name: 'result.regions-2.txt',
        path: '/data/result.regions-2.txt',
        text: '1\t9\t8\t7\t255\tResult\n'
      },
      tableError: null
    })
    h.runtime.init()

    await h.runtime.addOverlayDialog()

    expect(h.ownedCoordinator.openOverlay).toHaveBeenCalledWith(file.name, file.bytes, {
      sourcePath: file.path,
      labelTable: new Map([[1, { name: 'Result', rgba: [9, 8, 7, 255] }]]),
      labelTableName: 'result.regions-2.txt'
    })
  })

  it('attaches a separately selected table to the exact existing layer', async () => {
    const h = runtimeHarness()
    h.store.getState().setVolume(volume('base.nii'))
    h.store.getState().addOverlay(volume('result.regions-2.nii.gz'), {
      sourcePath: '/data/result.regions-2.nii.gz'
    })
    h.bridge.openOverlayDialog.mockResolvedValue({
      kind: 'table',
      table: {
        name: 'result.regions-2.txt',
        path: '/data/result.regions-2.txt',
        text: '1\t9\t8\t7\t255\tResult\n'
      }
    })
    h.runtime.init()

    await h.runtime.addOverlayDialog()

    expect(h.store.getState().overlays[0]).toMatchObject({ kind: 'labels' })
    expect(h.store.getState().overlays[0].labelTable?.get(1)?.name).toBe('Result')
  })

  it('applies targeted custom and built-in tables while retaining both choices', async () => {
    const h = runtimeHarness()
    h.store.getState().setVolume(volume('base.nii'), '/data/base.nii')
    h.store.getState().addOverlay(volume('layer.nii'), { sourcePath: '/data/layer.nii' })
    const id = h.store.getState().overlays[0].id
    h.store.getState().updateOverlay(id, { kind: 'labels' })
    h.bridge.openLayerTable.mockResolvedValue({
      name: 'picked.txt',
      path: '/data/picked.txt',
      text: '1\t9\t8\t7\t255\tCustom\n'
    })
    h.bridge.readBuiltInLayerTable.mockResolvedValue({
      name: 'FreeSurferColorLUT.txt',
      path: '',
      text: '2 Built-In 6 5 4 0\n'
    })
    h.runtime.init()

    await h.runtime.chooseOverlayTable(id)
    expect(h.bridge.openLayerTable).toHaveBeenCalledWith(expect.any(Number), '/data/base.nii')
    expect(h.store.getState().overlays[0]).toMatchObject({
      labelTableSource: 'custom',
      customTable: { name: 'picked.txt' }
    })

    await h.runtime.useBuiltInOverlayTable(id)
    expect(h.store.getState().overlays[0]).toMatchObject({
      labelTableSource: 'built-in',
      builtInTable: { name: 'FreeSurfer' },
      customTable: { name: 'picked.txt' }
    })
    expect(h.store.getState().overlays[0].labelTable?.get(2)?.rgba).toEqual([6, 5, 4, 255])
  })

  it('drops a targeted table result after its layer is removed', async () => {
    const h = runtimeHarness()
    const selected = deferred<OpenedLayerTable | null>()
    h.store.getState().setVolume(volume('base.nii'))
    h.store.getState().addOverlay(volume('layer.nii'))
    const id = h.store.getState().overlays[0].id
    h.store.getState().updateOverlay(id, { kind: 'labels' })
    h.bridge.openLayerTable.mockReturnValueOnce(selected.promise)
    h.runtime.init()

    const choosing = h.runtime.chooseOverlayTable(id)
    h.store.getState().removeOverlay(id)
    selected.resolve({ name: 'picked.txt', path: '/picked.txt', text: '1\t1\t2\t3\t255\tOne' })
    await choosing

    expect(h.store.getState().overlays).toEqual([])
  })

  it('drops a targeted table error after its layer is removed', async () => {
    const h = runtimeHarness()
    const selected = deferred<OpenedLayerTable | null>()
    h.store.getState().setVolume(volume('base.nii'))
    h.store.getState().addOverlay(volume('layer.nii'))
    const id = h.store.getState().overlays[0].id
    h.store.getState().updateOverlay(id, { kind: 'labels' })
    h.bridge.openLayerTable.mockReturnValueOnce(selected.promise)
    h.runtime.init()

    const choosing = h.runtime.chooseOverlayTable(id)
    h.store.getState().removeOverlay(id)
    selected.reject(new Error('late failure'))
    await choosing

    expect(h.store.getState().errorMessage).toBeNull()
  })

  it('keeps the latest targeted table request for each layer', async () => {
    const h = runtimeHarness()
    const first = deferred<OpenedLayerTable | null>()
    const second = deferred<OpenedLayerTable | null>()
    h.store.getState().setVolume(volume('base.nii'))
    h.store.getState().addOverlay(volume('layer.nii'))
    const id = h.store.getState().overlays[0].id
    h.store.getState().updateOverlay(id, { kind: 'labels' })
    h.bridge.openLayerTable.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    h.runtime.init()

    const firstChoice = h.runtime.chooseOverlayTable(id)
    const secondChoice = h.runtime.chooseOverlayTable(id)
    second.resolve({ name: 'second.txt', path: '/second.txt', text: '2\t1\t2\t3\t255\tSecond' })
    await secondChoice
    first.resolve({ name: 'first.txt', path: '/first.txt', text: '1\t1\t2\t3\t255\tFirst' })
    await firstChoice

    expect(h.bridge.cancelFileRead).toHaveBeenCalledTimes(1)
    expect(h.store.getState().overlays[0]).toMatchObject({
      labelTableSource: 'custom',
      customTable: { name: 'second.txt' }
    })
  })

  it('invalidates a targeted table read when a newer source is selected', async () => {
    const h = runtimeHarness()
    const selected = deferred<OpenedLayerTable | null>()
    h.store.getState().setVolume(volume('base.nii'))
    h.store.getState().addOverlay(volume('layer.nii'))
    const id = h.store.getState().overlays[0].id
    h.store.getState().updateOverlay(id, { kind: 'labels' })
    h.bridge.openLayerTable.mockReturnValueOnce(selected.promise)
    h.runtime.init()

    const choosing = h.runtime.chooseOverlayTable(id)
    h.runtime.selectOverlayTableSource(id, 'automatic')
    selected.reject(new Error('late failure'))
    await choosing

    expect(h.bridge.cancelFileRead).toHaveBeenCalledTimes(1)
    expect(h.store.getState().overlays[0].labelTableSource).toBe('automatic')
    expect(h.store.getState().errorMessage).toBeNull()
  })

  it('drops a targeted table result after its layer type changes', async () => {
    const h = runtimeHarness()
    const selected = deferred<OpenedLayerTable | null>()
    h.store.getState().setVolume(volume('base.nii'))
    h.store.getState().addOverlay(volume('layer.nii'))
    const id = h.store.getState().overlays[0].id
    h.store.getState().updateOverlay(id, { kind: 'labels' })
    h.bridge.openLayerTable.mockReturnValueOnce(selected.promise)
    h.runtime.init()

    const choosing = h.runtime.chooseOverlayTable(id)
    h.store.getState().updateOverlay(id, { kind: 'map' })
    selected.resolve({ name: 'picked.txt', path: '/picked.txt', text: '1\t1\t2\t3\t255\tOne' })
    await choosing

    expect(h.store.getState().overlays[0]).toMatchObject({
      kind: 'map',
      customTable: null
    })
  })

  it('drops an overlay dialog result when the base session changed during the picker read', async () => {
    const h = runtimeHarness()
    const selected = deferred<OpenedLayer | null>()
    h.store.getState().setVolume(volume('first.nii'))
    h.bridge.openOverlayDialog.mockReturnValueOnce(selected.promise)
    h.runtime.init()

    const adding = h.runtime.addOverlayDialog()
    h.store.getState().setVolume(volume('replacement.nii'))
    expect(h.bridge.cancelFileRead).toHaveBeenCalledTimes(1)
    selected.resolve({ kind: 'volume', file: opened('late.nii'), table: null, tableError: null })
    await adding

    expect(h.ownedCoordinator.openOverlay).not.toHaveBeenCalled()
  })

  it('binds a main-side overlay read to the base session visible at its start', () => {
    const h = runtimeHarness()
    h.store.getState().setVolume(volume('first.nii'))
    h.runtime.init()
    h.bridge.emit('overlay-started', 9)
    h.store.getState().setVolume(volume('replacement.nii'))
    h.bridge.emit('overlay-opened', 9, opened('late.nii'))
    h.bridge.emit('overlay-error', 9, 'late error')

    expect(h.ownedCoordinator.openOverlay).not.toHaveBeenCalled()
    expect(h.store.getState().errorMessage).toBeNull()
  })

  it('routes close confirmation through the active responder lease', async () => {
    const h = runtimeHarness()
    h.runtime.init()
    await tick()
    h.store.setState({ segDirty: true })
    h.confirm.mockReturnValueOnce(false).mockReturnValueOnce(true)
    h.bridge.emit('close', 11, 1)
    h.bridge.emit('close', 12, 1)
    expect(h.bridge.cancelClose).toHaveBeenCalledWith(11, 1)
    expect(h.bridge.confirmClose).toHaveBeenCalledWith(12, 1)
  })

  it('ignores a close request addressed to a replaced responder lease', async () => {
    const h = runtimeHarness()
    h.runtime.init()
    await tick()
    h.store.setState({ segDirty: true })

    h.bridge.emit('close', 11, 2)

    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.bridge.confirmClose).not.toHaveBeenCalled()
    expect(h.bridge.cancelClose).not.toHaveBeenCalled()
  })

  it('keeps text undo native and routes other menu history to regions', () => {
    const h = runtimeHarness()
    const undo = vi.fn()
    const redo = vi.fn()
    h.store.setState({ undo, redo })
    h.runtime.init()

    h.document.activeElement = { tagName: 'textarea' }
    h.bridge.emit('undo')
    h.bridge.emit('redo')
    expect(h.document.execCommand).toHaveBeenNthCalledWith(1, 'undo')
    expect(h.document.execCommand).toHaveBeenNthCalledWith(2, 'redo')
    expect(undo).not.toHaveBeenCalled()

    h.document.activeElement = { tagName: 'input', type: 'range' }
    h.bridge.emit('undo')
    h.bridge.emit('redo')
    expect(undo).toHaveBeenCalledTimes(1)
    expect(redo).toHaveBeenCalledTimes(1)
  })

  it('blocks menu and global commands while the shortcuts window is open', () => {
    const h = runtimeHarness()
    const undo = vi.fn()
    const commitPreview = vi.fn()
    h.store.setState({
      undo,
      commitPreview,
      shortcutsOpen: true,
      segBox: {} as never,
      folder: scan()
    })
    h.runtime.init()
    h.bridge.emit('undo')
    h.window.dispatch('keydown', { key: 'Enter', target: null, preventDefault: vi.fn() })
    h.window.dispatch('keydown', { key: 'ArrowDown', target: null, preventDefault: vi.fn() })
    expect(undo).not.toHaveBeenCalled()
    expect(commitPreview).not.toHaveBeenCalled()
    expect(h.ownedCoordinator.navigate).not.toHaveBeenCalled()
  })

  it('routes global region, brush, undo, folder, and shortcuts commands', async () => {
    const h = runtimeHarness()
    const cancelSeg = vi.fn()
    const setBrushRadius = vi.fn()
    const undo = vi.fn()
    h.store.setState({
      cancelSeg,
      setBrushRadius,
      undo,
      segBox: {} as never,
      folder: scan(),
      brushRadius: 4
    })
    h.runtime.init()
    h.window.dispatch('keydown', { key: 'Escape', target: null, preventDefault: vi.fn() })
    h.store.setState({ segBox: null })
    h.window.dispatch('keydown', { key: '[', target: null, preventDefault: vi.fn() })
    h.window.dispatch('keydown', { key: 'z', ctrlKey: true, target: null, preventDefault: vi.fn() })
    h.window.dispatch('keydown', { key: 'ArrowUp', target: null, preventDefault: vi.fn() })
    h.window.dispatch('keydown', { key: '?', target: null, preventDefault: vi.fn() })
    await tick()
    expect(cancelSeg).toHaveBeenCalledTimes(1)
    expect(setBrushRadius).toHaveBeenCalledWith(3)
    expect(undo).toHaveBeenCalledTimes(1)
    expect(h.ownedCoordinator.navigate).toHaveBeenCalledWith(-1, 1)
    expect(h.store.getState().shortcutsOpen).toBe(true)
  })
})

describe('folder and drop flows', () => {
  it('prevents folder dialog re-entry and releases the lock after success and cancel', async () => {
    const h = runtimeHarness()
    const first = deferred<FolderScan | null>()
    h.bridge.openFolderScan.mockImplementationOnce(() => first.promise)
    h.runtime.init()

    const one = h.runtime.openFolderDialog()
    const duplicate = h.runtime.openFolderDialog()
    await tick()
    expect(h.ownedCoordinator.scanFolder).toHaveBeenCalledTimes(1)
    first.resolve(scan())
    await Promise.all([one, duplicate])

    h.bridge.openFolderScan.mockResolvedValueOnce(null)
    await h.runtime.openFolderDialog()
    expect(h.ownedCoordinator.scanFolder).toHaveBeenCalledTimes(2)
  })

  it('releases the folder lock and routes failure through its original intent', async () => {
    const h = runtimeHarness()
    const failure = new Error("Error invoking remote method 'open-folder-scan': Error: Scan failed")
    h.bridge.openFolderScan.mockRejectedValueOnce(failure)
    h.runtime.init()
    await h.runtime.openFolderDialog()
    expect(h.ownedCoordinator.reportBaseError).toHaveBeenCalledWith(failure, 1)

    h.bridge.openFolderScan.mockResolvedValueOnce(null)
    await h.runtime.openFolderDialog()
    expect(h.ownedCoordinator.scanFolder).toHaveBeenCalledTimes(2)
  })

  it('does not let a scan outer catch overwrite newer base loading feedback', async () => {
    const h = runtimeHarness()
    h.runtime.dispose()
    const scanResult = deferred<FolderScan | null>()
    const parse = deferred<Volume>()
    h.bridge.openFolderScan.mockReturnValueOnce(scanResult.promise)
    const runtime = createRendererRuntime({
      ...h.deps,
      createCoordinator: undefined,
      loadVolume: () => parse.promise
    })
    runtimes.push(runtime)
    runtime.init()
    const folderOpen = runtime.openFolderDialog()
    await tick()

    scanResult.reject(new Error('Older scan failed.'))
    queueMicrotask(() => h.bridge.emit('file-opened', 2, opened('newer.nii')))
    await folderOpen

    expect(h.store.getState().loadState).toBe('loading')
    expect(h.store.getState().errorMessage).toBeNull()
    parse.resolve(volume('newer.nii'))
    await tick()
    expect(h.store.getState().volume?.name).toBe('newer.nii')
  })

  it('publishes drag state and resolves split drop zones', () => {
    const h = runtimeHarness()
    const snapshots: Array<{ dragging: boolean; dropTarget: string }> = []
    h.runtime.subscribeUi(() => snapshots.push(h.runtime.getUiSnapshot()))
    h.runtime.init()
    h.window.dispatch('dragenter', dragEvent())
    h.window.dispatch('dragover', dragEvent(undefined, 'base'))
    h.window.dispatch('dragleave', {})
    expect(snapshots).toEqual([
      { dragging: true, dropTarget: 'auto' },
      { dragging: true, dropTarget: 'base' },
      { dragging: false, dropTarget: 'base' }
    ])
  })

  it('routes ordinary drops to base or overlay using the drop-time snapshot', async () => {
    const h = runtimeHarness()
    const file = dropFile()
    h.bridge.pathForFile.mockReturnValue('/x/a.nii')
    h.runtime.init()

    h.window.dispatch('drop', dragEvent(file))
    await tick()
    expect(h.ownedCoordinator.openBase).toHaveBeenCalledTimes(1)

    h.store.setState({ volume: volume() })
    h.window.dispatch('drop', dragEvent(file))
    await tick()
    expect(h.ownedCoordinator.openOverlay).toHaveBeenCalledTimes(1)

    h.window.dispatch('drop', dragEvent(file, 'base'))
    await tick()
    expect(h.ownedCoordinator.openBase).toHaveBeenCalledTimes(2)
  })

  it('does not read base-drop bytes after a newer intent wins during the path probe', async () => {
    const h = runtimeHarness()
    const probe = deferred<boolean>()
    const file = dropFile('slow.nii')
    h.bridge.pathForFile.mockReturnValue('/x/slow.nii')
    h.bridge.isDirectory.mockReturnValueOnce(probe.promise)
    h.runtime.init()

    h.window.dispatch('drop', dragEvent(file, 'base'))
    await tick()
    h.store.openIntentGate.accept(2)
    probe.resolve(false)
    await tick()

    expect(file.arrayBuffer).not.toHaveBeenCalled()
    expect(h.ownedCoordinator.openBase).not.toHaveBeenCalled()
  })

  it('drops overlay bytes that finish after the base session is replaced', async () => {
    const h = runtimeHarness()
    const data = deferred<ArrayBuffer>()
    const file = {
      name: 'late.nii',
      size: 8,
      arrayBuffer: vi.fn(() => data.promise)
    } as unknown as File
    h.store.getState().setVolume(volume('first.nii'))
    h.runtime.init()

    h.window.dispatch('drop', dragEvent(file, 'overlay'))
    await vi.waitFor(() => expect(file.arrayBuffer).toHaveBeenCalledTimes(1))
    h.store.getState().setVolume(volume('replacement.nii'))
    data.resolve(bytes())
    await tick()

    expect(h.ownedCoordinator.openOverlay).not.toHaveBeenCalled()
  })

  it('drops a standalone table whose text finishes after the base session changes', async () => {
    const h = runtimeHarness()
    const text = deferred<string>()
    const table = {
      name: 'result.txt',
      size: 32,
      text: vi.fn(() => text.promise)
    } as unknown as File
    h.bridge.pathForFile.mockImplementation((file) => `/data/${file.name}`)
    h.store.getState().setVolume(volume('first.nii'))
    h.store.getState().addOverlay(volume('result.nii'), { sourcePath: '/data/result.nii' })
    h.runtime.init()

    h.window.dispatch('drop', dragEvent(table, 'overlay'))
    await vi.waitFor(() => expect(table.text).toHaveBeenCalledTimes(1))
    h.store.getState().setVolume(volume('replacement.nii'))
    h.store.getState().addOverlay(volume('result.nii'), { sourcePath: '/data/result.nii' })
    text.resolve('1\t1\t2\t3\t255\tOld\n')
    await tick()

    expect(h.store.getState().overlays[0].labelTable).toBeNull()
  })

  it('drops a paired table whose text finishes after the base session changes', async () => {
    const h = runtimeHarness()
    const text = deferred<string>()
    const file = dropFile('result.nii')
    const table = {
      name: 'result.txt',
      size: 32,
      text: vi.fn(() => text.promise)
    } as unknown as File
    h.bridge.pathForFile.mockImplementation((candidate) => `/data/${candidate.name}`)
    h.store.getState().setVolume(volume('first.nii'))
    h.runtime.init()

    h.window.dispatch('drop', dragEvent([file, table], 'overlay'))
    await vi.waitFor(() => expect(table.text).toHaveBeenCalledTimes(1))
    h.store.getState().setVolume(volume('replacement.nii'))
    text.resolve('1\t1\t2\t3\t255\tOld\n')
    await tick()

    expect(h.ownedCoordinator.openOverlay).not.toHaveBeenCalled()
  })

  it('routes a directory drop into scanning without opening it as a file', async () => {
    const h = runtimeHarness()
    const file = dropFile('folder', 0)
    h.bridge.pathForFile.mockReturnValue('/folder')
    h.bridge.isDirectory.mockResolvedValue(true)
    h.bridge.scanDroppedFolder.mockResolvedValue(scan())
    h.runtime.init()
    h.window.dispatch('drop', dragEvent(file, 'overlay'))
    await tick()
    expect(h.bridge.scanDroppedFolder).toHaveBeenCalledWith(file, 1)
    expect(h.ownedCoordinator.openBase).not.toHaveBeenCalled()
    expect(h.ownedCoordinator.openOverlay).not.toHaveBeenCalled()
  })

  it('reports rejected names and oversized drops before reading bytes', async () => {
    const h = runtimeHarness()
    h.runtime.init()
    const wrong = dropFile('a.zip')
    h.window.dispatch('drop', dragEvent(wrong))
    await tick()
    expect(h.ownedCoordinator.reportBaseError).toHaveBeenCalledWith(
      expect.stringContaining('.nii'),
      1
    )

    const large = dropFile('a.nii', 10)
    h.deps.maxBytes = 5
    h.window.dispatch('drop', dragEvent(large))
    await tick()
    expect(h.ownedCoordinator.reportBaseError).toHaveBeenLastCalledWith(
      expect.stringContaining('larger than 2 GB'),
      2
    )
    expect(large.arrayBuffer).not.toHaveBeenCalled()
  })

  it('preserves a direct base rejection message through the ordering coordinator', async () => {
    const h = runtimeHarness()
    h.runtime.dispose()
    const runtime = createRendererRuntime({ ...h.deps, createCoordinator: undefined })
    runtimes.push(runtime)
    runtime.init()

    h.window.dispatch('drop', dragEvent(dropFile('a.zip')))
    await tick()
    expect(h.store.getState().errorMessage).toContain('.nii')
  })
})

describe('disposed async work', () => {
  it('ignores a dialog result that arrives after dispose', async () => {
    const h = runtimeHarness()
    const result = deferred<OpenedFile | null>()
    h.bridge.openDialog.mockImplementation(() => result.promise)
    h.runtime.init()
    const pending = h.runtime.openFileDialog()
    h.runtime.dispose()
    result.resolve(opened())
    await pending
    expect(h.ownedCoordinator.openBase).not.toHaveBeenCalled()
  })

  it('cancels an overlay dialog read when its runtime is disposed', async () => {
    const h = runtimeHarness()
    const result = deferred<OpenedFile | null>()
    h.bridge.openOverlayDialog.mockReturnValueOnce(result.promise)
    h.runtime.init()

    const pending = h.runtime.addOverlayDialog()
    await vi.waitFor(() => expect(h.bridge.openOverlayDialog).toHaveBeenCalledTimes(1))
    h.runtime.dispose()

    expect(h.bridge.cancelFileRead).toHaveBeenCalledWith(expect.any(Number))
    result.resolve(opened())
    await pending
    expect(h.ownedCoordinator.openOverlay).not.toHaveBeenCalled()
  })

  it('cancels an obsolete main-side folder read before starting the new target', async () => {
    const h = runtimeHarness()
    h.runtime.dispose()
    const reads: Array<{
      path: string
      requestId: number
      result: Deferred<OpenedFile>
    }> = []
    h.bridge.readFile.mockImplementation((path, requestId) => {
      const result = deferred<OpenedFile>()
      reads.push({ path, requestId, result })
      return result.promise
    })
    h.store.setState({
      sourcePath: '/r/a.nii',
      folder: {
        root: '/r',
        files: [
          { name: 'a.nii', path: '/r/a.nii', relDir: '' },
          { name: 'b.nii', path: '/r/b.nii', relDir: '' },
          { name: 'c.nii', path: '/r/c.nii', relDir: '' }
        ],
        truncated: false
      }
    })
    const runtime = createRendererRuntime({ ...h.deps, createCoordinator: undefined })
    runtimes.push(runtime)
    runtime.init()

    runtime.requestEntry('/r/b.nii')
    await tick()
    expect(reads.map((read) => read.path)).toEqual(['/r/b.nii'])
    runtime.requestEntry('/r/c.nii')
    await tick()

    expect(h.bridge.cancelFileRead).toHaveBeenCalledWith(reads[0].requestId)
    expect(reads.map((read) => read.path)).toEqual(['/r/b.nii', '/r/c.nii'])
    expect(reads[1].requestId).not.toBe(reads[0].requestId)

    runtime.dispose()
    expect(h.bridge.cancelFileRead).toHaveBeenCalledWith(reads[1].requestId)
    for (const read of reads) read.result.resolve(opened(read.path.split('/').at(-1), read.path))
    await tick()
  })

  it('cancels a main-side prefetch when the runtime is disposed', async () => {
    const h = runtimeHarness()
    h.runtime.dispose()
    const result = deferred<OpenedFile | null>()
    let requestId = 0
    h.bridge.readFileWithin.mockImplementation((_path, _maxBytes, ownedRequestId) => {
      requestId = ownedRequestId
      return result.promise
    })
    h.store.setState({
      sourcePath: '/r/a.nii',
      folder: {
        root: '/r',
        files: [
          { name: 'a.nii', path: '/r/a.nii', relDir: '' },
          { name: 'b.nii', path: '/r/b.nii', relDir: '' }
        ],
        truncated: false
      }
    })
    const runtime = createRendererRuntime({ ...h.deps, createCoordinator: undefined })
    runtimes.push(runtime)
    runtime.init()

    runtime.requestEntry('/r/a.nii')
    await tick()
    expect(h.bridge.readFileWithin).toHaveBeenCalledWith('/r/b.nii', expect.any(Number), requestId)

    runtime.dispose()
    expect(h.bridge.cancelFileRead).toHaveBeenCalledWith(requestId)
    result.resolve(null)
    await tick()
  })

  it('invalidates a parse and settles loading when dispose happens first', async () => {
    const h = runtimeHarness()
    h.runtime.dispose()
    const parse = deferred<Volume>()
    let signal: AbortSignal | undefined
    const runtime = createRendererRuntime({
      ...h.deps,
      createCoordinator: undefined,
      loadVolume: (_name, _bytes, options) => {
        signal = options?.signal
        return parse.promise
      }
    })
    runtimes.push(runtime)
    runtime.init()
    h.bridge.emit('file-opened', 1, opened())
    await tick()
    expect(h.store.getState().loadState).toBe('loading')
    expect(signal?.aborted).toBe(false)
    runtime.dispose()
    expect(signal?.aborted).toBe(true)
    expect(h.store.getState().loadState).not.toBe('loading')
    parse.resolve(volume('late.nii'))
    await tick()
    expect(h.store.getState().volume).toBe(null)
  })

  it('passes cancellation ownership to an overlay worker and aborts it on dispose', async () => {
    const h = runtimeHarness()
    h.runtime.dispose()
    const parse = deferred<Volume>()
    let options: { skipTex?: true; signal?: AbortSignal } | undefined
    const runtime = createRendererRuntime({
      ...h.deps,
      createCoordinator: undefined,
      loadVolume: (_name, _bytes, loadOptions) => {
        options = loadOptions
        return parse.promise
      }
    })
    runtimes.push(runtime)
    h.store.getState().setVolume(volume())
    runtime.init()
    h.bridge.emit('overlay-started', 20)
    h.bridge.emit('overlay-opened', 20, opened('layer.nii'))
    await tick()

    expect(options?.skipTex).toBe(true)
    expect(options?.signal?.aborted).toBe(false)
    runtime.dispose()
    expect(options?.signal?.aborted).toBe(true)

    parse.reject(new Error('aborted'))
    await tick()
    expect(h.store.getState().overlays).toEqual([])
  })

  it('drops a layer parse that settles after the base identity changes', async () => {
    const h = runtimeHarness()
    h.runtime.dispose()
    const layerParse = deferred<Volume>()
    const runtime = createRendererRuntime({
      ...h.deps,
      createCoordinator: undefined,
      loadVolume: (_name, _bytes, options) =>
        options?.skipTex ? layerParse.promise : Promise.resolve(volume('replacement.nii'))
    })
    runtimes.push(runtime)
    const original = volume('original.nii')
    h.store.getState().setVolume(original)
    runtime.init()

    h.bridge.emit('overlay-started', 21)
    h.bridge.emit('overlay-opened', 21, opened('layer.nii'))
    await tick()
    expect(h.store.getState().loadState).toBe('loading')
    h.store.getState().setVolume(volume('replacement.nii'))
    layerParse.resolve(volume('layer.nii'))
    await tick()

    expect(h.store.getState().overlays).toEqual([])
    expect(h.store.getState().loadState).toBe('ready')
  })

  it('does not clear a newer load error when a stale layer parse settles', async () => {
    const h = runtimeHarness()
    h.runtime.dispose()
    const layerParse = deferred<Volume>()
    const runtime = createRendererRuntime({
      ...h.deps,
      createCoordinator: undefined,
      loadVolume: (_name, _bytes, options) =>
        options?.skipTex ? layerParse.promise : Promise.resolve(volume('replacement.nii'))
    })
    runtimes.push(runtime)
    h.store.getState().setVolume(volume('original.nii'))
    runtime.init()

    h.bridge.emit('overlay-started', 22)
    h.bridge.emit('overlay-opened', 22, opened('layer.nii'))
    await tick()
    h.store.getState().setVolume(volume('replacement.nii'))
    h.store.getState().fail('Replacement failed.')
    layerParse.resolve(volume('layer.nii'))
    await tick()

    expect(h.store.getState().overlays).toEqual([])
    expect(h.store.getState().errorMessage).toBe('Replacement failed.')
  })

  it('does not replace a newer direct error when a stale layer parse rejects', async () => {
    const h = runtimeHarness()
    h.runtime.dispose()
    const layerParse = deferred<Volume>()
    const runtime = createRendererRuntime({
      ...h.deps,
      createCoordinator: undefined,
      loadVolume: (_name, _bytes, options) =>
        options?.skipTex ? layerParse.promise : Promise.resolve(volume('replacement.nii'))
    })
    runtimes.push(runtime)
    h.store.getState().setVolume(volume('original.nii'))
    runtime.init()

    h.bridge.emit('overlay-started', 23)
    h.bridge.emit('overlay-opened', 23, opened('layer.nii'))
    await tick()
    h.store.getState().setVolume(volume('replacement.nii'))
    h.store.getState().fail('Replacement failed.')
    layerParse.reject(new Error('Layer failed.'))
    await tick()

    expect(h.store.getState().errorMessage).toBe('Replacement failed.')
  })
})
