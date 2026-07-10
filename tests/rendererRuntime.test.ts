import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppStore, type AppStore, type PreviewController } from '../src/renderer/src/store'
import type { Volume } from '../src/renderer/src/volume/types'
import type { FolderScan, OpenedFile } from '../src/shared/files'
import {
  createRendererRuntime,
  type RendererBridge,
  type RendererRuntime,
  type RendererRuntimeDeps,
  type RuntimeCoordinator,
  type RuntimeDocument,
  type RuntimeEventTarget
} from '../src/renderer/src/runtime/rendererRuntime'

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
  openFolderScan: ReturnType<typeof vi.fn<RendererBridge['openFolderScan']>>
  scanDroppedFolder: ReturnType<typeof vi.fn<RendererBridge['scanDroppedFolder']>>
  isDirectory: ReturnType<typeof vi.fn<RendererBridge['isDirectory']>>
  pathForFile: ReturnType<typeof vi.fn<RendererBridge['pathForFile']>>
  sendViewState: ReturnType<typeof vi.fn<RendererBridge['sendViewState']>>
  releaseFolderAccess: ReturnType<typeof vi.fn<RendererBridge['releaseFolderAccess']>>
  confirmClose: ReturnType<typeof vi.fn<RendererBridge['confirmClose']>>
  cancelClose: ReturnType<typeof vi.fn<RendererBridge['cancelClose']>>
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
  const openFolderScan = vi.fn<RendererBridge['openFolderScan']>(async () => null)
  const scanDroppedFolder = vi.fn<RendererBridge['scanDroppedFolder']>(async () => null)
  const isDirectory = vi.fn<RendererBridge['isDirectory']>(async () => false)
  const pathForFile = vi.fn<RendererBridge['pathForFile']>(() => '')
  const sendViewState = vi.fn<RendererBridge['sendViewState']>()
  const releaseFolderAccess = vi.fn<RendererBridge['releaseFolderAccess']>()
  const confirmClose = vi.fn<RendererBridge['confirmClose']>()
  const cancelClose = vi.fn<RendererBridge['cancelClose']>()
  const bridge: RendererBridge = {
    platform: 'darwin',
    openDialog,
    onFileOpened: (callback) => listen('file-opened', callback as Callback),
    onOverlayOpened: (callback) => listen('overlay-opened', callback as Callback),
    onFileOpenError: (callback) => listen('file-error', callback as Callback),
    onOpenFolderRequest: (callback) => listen('open-folder', callback as Callback),
    onShowShortcuts: (callback) => listen('show-shortcuts', callback as Callback),
    onMenuUndo: (callback) => listen('undo', callback as Callback),
    onMenuRedo: (callback) => listen('redo', callback as Callback),
    onScanFolderProgress: (callback) => listen('scan-progress', callback as Callback),
    onCloseRequested: (callback) => listen('close', callback as Callback),
    onToggleFilePanel: (callback) => listen('toggle-files', callback as Callback),
    onToggleSidePanel: (callback) => listen('toggle-side', callback as Callback),
    openFolderScan,
    scanDroppedFolder,
    isDirectory,
    pathForFile,
    readFile: vi.fn(async (path) => ({ ...opened(), path })),
    readFileWithin: vi.fn(async () => null),
    noteFileOpened: vi.fn(),
    sendViewState,
    confirmFolderScan: vi.fn(),
    cancelFolderScan: vi.fn(),
    releaseFolderAccess,
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
    openFolderScan,
    scanDroppedFolder,
    isDirectory,
    pathForFile,
    sendViewState,
    releaseFolderAccess,
    confirmClose,
    cancelClose
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

function dragEvent(file?: File, zone: 'base' | 'overlay' | 'auto' = 'auto'): object {
  return {
    dataTransfer: { types: ['Files'], files: file ? [file] : [] },
    target: {
      closest: () => (zone === 'auto' ? null : { dataset: { dropTarget: zone } })
    },
    preventDefault: vi.fn()
  }
}

describe('renderer runtime lifecycle', () => {
  it('initializes once, owns every subscription, and disposes repeatably', () => {
    const h = runtimeHarness()
    h.runtime.init()
    h.runtime.init()

    expect(h.coordinatorFactory).toHaveBeenCalledTimes(1)
    expect(h.bridge.unsubscribes).toHaveLength(11)
    expect(h.window.add).toHaveBeenCalledTimes(5)
    expect(h.bridge.sendViewState).toHaveBeenCalledTimes(1)
    expect(h.document.title).toBe('neoview')

    h.runtime.dispose()
    h.runtime.dispose()
    expect(h.ownedCoordinator.dispose).toHaveBeenCalledTimes(1)
    expect(h.bridge.unsubscribes.every((off) => off.mock.calls.length === 1)).toBe(true)
    expect(h.window.remove).toHaveBeenCalledTimes(5)
    expect(h.storeUnsubscribe).toHaveBeenCalledTimes(1)
  })

  it('mount, unmount, and mount again leaves only the new listeners active', () => {
    const h = runtimeHarness()
    h.runtime.init()
    h.runtime.dispose()

    const nextCoordinator = coordinator()
    const next = createRendererRuntime({ ...h.deps, createCoordinator: () => nextCoordinator })
    runtimes.push(next)
    next.init()

    for (const name of ['file-opened', 'overlay-opened', 'close', 'toggle-files']) {
      expect(h.bridge.listenerCount(name)).toBe(1)
    }
    for (const type of ['keydown', 'dragenter', 'dragleave', 'dragover', 'drop']) {
      expect(h.window.listenerCount(type)).toBe(1)
    }
    h.bridge.emit('file-opened', opened())
    expect(h.ownedCoordinator.openBase).not.toHaveBeenCalled()
    expect(nextCoordinator.openBase).toHaveBeenCalledTimes(1)
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
      fileList: false,
      sidePanel: true,
      folderOpen: false
    })
    expect(h.bridge.sendViewState).toHaveBeenCalledTimes(2)
  })
})

describe('renderer runtime event routing', () => {
  it('routes file, overlay, error, scan batch, and panel IPC events', () => {
    const h = runtimeHarness()
    h.runtime.init()
    const file = opened('sample.nii', '')
    h.bridge.emit('file-opened', file)
    h.bridge.emit('overlay-opened', file)
    h.bridge.emit('file-error', 'Read failed')
    h.bridge.emit('scan-progress', 3, '/r', scan('/r').files)
    h.bridge.emit('toggle-files')
    h.bridge.emit('toggle-side')
    h.bridge.emit('show-shortcuts')

    expect(h.ownedCoordinator.openBase).toHaveBeenCalledWith(file.name, file.bytes, null)
    expect(h.ownedCoordinator.openOverlay).toHaveBeenCalledWith(file.name, file.bytes)
    expect(h.ownedCoordinator.onScanBatch).toHaveBeenCalledWith(3, '/r', scan('/r').files)
    expect(h.store.getState().errorMessage).toBe('Read failed')
    expect(h.store.getState().filePanelOpen).toBe(false)
    expect(h.store.getState().sidePanelOpen).toBe(false)
    expect(h.store.getState().shortcutsOpen).toBe(true)
  })

  it('routes explicit file and overlay dialogs through their distinct entries', async () => {
    const h = runtimeHarness()
    const file = opened()
    h.bridge.openDialog.mockResolvedValue(file)
    h.runtime.init()
    await h.runtime.openFileDialog()
    await h.runtime.addOverlayDialog()
    expect(h.ownedCoordinator.openBase).toHaveBeenCalledWith(file.name, file.bytes, file.path)
    expect(h.ownedCoordinator.openOverlay).toHaveBeenCalledWith(file.name, file.bytes)
  })

  it('routes close confirmation to confirm and cancel branches', () => {
    const h = runtimeHarness()
    h.runtime.init()
    h.store.setState({ segDirty: true })
    h.confirm.mockReturnValueOnce(false).mockReturnValueOnce(true)
    h.bridge.emit('close')
    h.bridge.emit('close')
    expect(h.bridge.cancelClose).toHaveBeenCalledTimes(1)
    expect(h.bridge.confirmClose).toHaveBeenCalledTimes(1)
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

  it('routes global region, brush, undo, folder, and shortcuts commands', () => {
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
    expect(cancelSeg).toHaveBeenCalledTimes(1)
    expect(setBrushRadius).toHaveBeenCalledWith(3)
    expect(undo).toHaveBeenCalledTimes(1)
    expect(h.ownedCoordinator.navigate).toHaveBeenCalledWith(-1)
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
    expect(h.ownedCoordinator.scanFolder).toHaveBeenCalledTimes(1)
    first.resolve(scan())
    await Promise.all([one, duplicate])

    h.bridge.openFolderScan.mockResolvedValueOnce(null)
    await h.runtime.openFolderDialog()
    expect(h.ownedCoordinator.scanFolder).toHaveBeenCalledTimes(2)
  })

  it('releases the folder lock after failure and cleans its message', async () => {
    const h = runtimeHarness()
    h.bridge.openFolderScan.mockRejectedValueOnce(
      new Error("Error invoking remote method 'open-folder-scan': Error: Scan failed")
    )
    h.runtime.init()
    await h.runtime.openFolderDialog()
    expect(h.store.getState().errorMessage).toBe('Scan failed')

    h.bridge.openFolderScan.mockResolvedValueOnce(null)
    await h.runtime.openFolderDialog()
    expect(h.ownedCoordinator.scanFolder).toHaveBeenCalledTimes(2)
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
    expect(h.store.getState().errorMessage).toContain('.nii')

    const large = dropFile('a.nii', 10)
    h.deps.maxBytes = 5
    h.window.dispatch('drop', dragEvent(large))
    await tick()
    expect(h.store.getState().errorMessage).toContain('larger than 2 GB')
    expect(large.arrayBuffer).not.toHaveBeenCalled()
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

  it('invalidates a parse and settles loading when dispose happens first', async () => {
    const h = runtimeHarness()
    h.runtime.dispose()
    const parse = deferred<Volume>()
    const runtime = createRendererRuntime({
      ...h.deps,
      createCoordinator: undefined,
      loadVolume: () => parse.promise
    })
    runtimes.push(runtime)
    runtime.init()
    h.bridge.emit('file-opened', opened())
    await tick()
    expect(h.store.getState().loadState).toBe('loading')
    runtime.dispose()
    expect(h.store.getState().loadState).not.toBe('loading')
    parse.resolve(volume('late.nii'))
    await tick()
    expect(h.store.getState().volume).toBe(null)
  })
})
