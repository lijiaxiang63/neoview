import { useStore as useZustandStore, type StoreApi, type UseBoundStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { OpenIntentGate } from '../../shared/openIntents'
import type { Volume } from './volume/types'
import { releaseFrameTextureSource } from './volume/loadVolume'
import { sortEntries, type FolderEntry } from './files/folderList'
import { loadViewPref, saveViewPref, type ViewPref } from './files/viewPrefs'
import {
  defaultUiPrefs,
  loadUiPrefs,
  saveUiPrefs,
  type SidePanelTab,
  type UiPrefs
} from './files/uiPrefs'
import { clampPanelWidth, SIDE_PANEL_WIDTH_DEFAULT } from './panelLayout'
import { defaultLayerSettings, guessOverlayKind, type OverlayLayer } from './slicing/overlay'
import { PreviewClient } from './segmentation/previewClient'
import { ModelRunner, type ModelController } from './model/modelRunner'
import {
  createRegionDomain,
  type PreviewController,
  type RegionActions,
  type RegionState,
  type RegionTimers
} from './store/regionDomain'
import type { RenderMode } from './render3d/types'

export {
  BRUSH_RADIUS_MAX,
  BRUSH_RADIUS_MIN,
  floodCap,
  normalizeSegParams,
  REGION_STATS_DEBOUNCE_MS,
  SLAB_DEPTH_DEFAULT
} from './store/regionDomain'
export type {
  ModelPreview,
  ModelRunState,
  PreviewController,
  SegConstraint,
  SegMethod,
  SegParams,
  SegPreview,
  SegSnapshot,
  SegTool,
  ToastItem,
  ToastState
} from './store/regionDomain'
export type { ModelController } from './model/modelRunner'

export type { SidePanelTab } from './files/uiPrefs'
export { SIDE_PANEL_WIDTH_DEFAULT, SIDE_PANEL_WIDTH_MAX, SIDE_PANEL_WIDTH_MIN } from './panelLayout'

export type Preset = 'auto' | 'full' | 'fixed-0-80' | 'suggested' | 'custom'

export type { RenderMode } from './render3d/types'

/** Slice-view colormap for the base volume ('gray' = the fused fast path). */
export type BaseColormap = 'gray' | 'warm' | 'cool'

export interface HoverInfo {
  view: 0 | 1 | 2
  ijk: [number, number, number]
}

/** An opened folder of volume files, shown in the file panel. */
export interface FolderState {
  root: string
  /** Pre-sorted by the caller (see files/folderList.ts#sortEntries). */
  files: FolderEntry[]
  /** True when the scan stopped at its file cap. */
  truncated: boolean
}

export interface AppState extends RegionState, RegionActions {
  volume: Volume | null
  /** Monotonic identity for the loaded base. Lightweight async owners use it
   * instead of retaining the potentially large Volume object. */
  volumeSession: number
  /** Absolute path of the opened base file (null for unknown origins). */
  sourcePath: string | null
  /** Opened folder; cleared when a base volume from outside it loads. */
  folder: FolderState | null
  /** True while a folder scan is in flight (feedback + re-entry guard). */
  folderLoading: boolean
  /** File list visibility; the folder stays open while the panel is hidden. */
  filePanelOpen: boolean
  /** Side panel visibility (a viewing pref — survives file changes). */
  sidePanelOpen: boolean
  /** Active side-panel tab (persisted with the panel layout prefs). */
  sidePanelTab: SidePanelTab
  /** Side panel width in pixels (persisted, clamped by panelLayout.ts). */
  sidePanelWidth: number
  /** Collapsed persisted sections by id; absent = open. */
  collapsedSections: Record<string, true>
  /** Primary direction labels drawn at the left and top panel edges of every slice. */
  directionLabelsVisible: boolean
  /** Shared slice crosshair visibility. */
  crosshairVisible: boolean
  /** Navigation target still being read/loaded (arrow-key scrubbing). */
  pendingFilePath: string | null
  loadState: 'empty' | 'loading' | 'ready' | 'error'
  errorMessage: string | null
  cross: [number, number, number]
  frame: number
  range: { lo: number; hi: number }
  activePreset: Preset
  hover: HoverInfo | null
  renderMode: RenderMode
  density: number
  brightness: number
  /** Base-volume slice colormap (a viewing pref — survives file changes). */
  baseColormap: BaseColormap
  /** Case-insensitive substring filter over the file panel's list. */
  fileFilter: string
  /** The modal shortcuts dialog. In the store so transient popups (region
   * context menu) can dismiss themselves when it opens above them. */
  shortcutsOpen: boolean
  /** Overlay layers in draw order: index 0 is the bottom-most. */
  overlays: OverlayLayer[]

  startLoading: () => void
  setVolume: (v: Volume, sourcePath?: string | null, settleLoad?: boolean) => void
  setFolder: (f: FolderState) => void
  /** Merge a streamed scan batch into the opened folder (kept sorted). */
  appendFolderFiles: (root: string, files: FolderEntry[]) => void
  closeFolder: () => void
  setFolderLoading: (b: boolean) => void
  toggleFilePanel: () => void
  toggleSidePanel: () => void
  setSidePanelTab: (tab: SidePanelTab) => void
  setSidePanelWidth: (px: number) => void
  resetSidePanelWidth: () => void
  toggleSection: (id: string) => void
  toggleDirectionLabels: () => void
  toggleCrosshair: () => void
  setPendingFilePath: (p: string | null) => void
  addOverlay: (v: Volume, settleLoad?: boolean) => void
  removeOverlay: (id: number) => void
  updateOverlay: (id: number, patch: Partial<Omit<OverlayLayer, 'id' | 'volume'>>) => void
  fail: (message: string) => void
  dismissError: () => void
  setCross: (ijk: [number, number, number]) => void
  setFrame: (t: number) => void
  setRange: (lo: number, hi: number) => void
  applyPreset: (p: Exclude<Preset, 'custom'>) => void
  setHover: (h: HoverInfo | null) => void
  setRenderMode: (m: RenderMode) => void
  setDensity: (d: number) => void
  setBrightness: (b: number) => void
  setBaseColormap: (c: BaseColormap) => void
  setFileFilter: (q: string) => void
  setShortcutsOpen: (open: boolean) => void
}

export interface PagehideTarget {
  addEventListener(type: 'pagehide', listener: () => void): void
  removeEventListener(type: 'pagehide', listener: () => void): void
}

export type AppStoreTimers = RegionTimers

export interface AppStoreDeps {
  /** Undefined uses the runtime localStorage; null disables persistence. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  /** Undefined uses the runtime window; null disables the pagehide binding. */
  pagehideTarget?: PagehideTarget | null
  /** Every call must return a controller owned by the new store instance. */
  createPreviewController?: () => PreviewController
  /** Every call must return a controller owned by the new store instance. */
  createModelController?: () => ModelController
  confirmModelReplace?: (message: string) => boolean
  timers?: AppStoreTimers
}

export type AppStore = UseBoundStore<StoreApi<AppState>> & {
  dispose: () => void
  /** Survives renderer-runtime replacement so late outer I/O cannot revive an
   * intent that an earlier runtime already superseded. */
  openIntentGate: OpenIntentGate
}

const identityState = (state: AppState): AppState => state

export const DENSITY_MIN = 0.02
export const DENSITY_MAX = 1
export const BRIGHTNESS_MIN = 0.05
export const BRIGHTNESS_MAX = 1
export const BRIGHTNESS_DEFAULT = 0.45

export function presetRange(vol: Volume, p: Exclude<Preset, 'custom'>): { lo: number; hi: number } {
  const { stats } = vol
  switch (p) {
    case 'auto':
      return { lo: stats.p2, hi: stats.p98 }
    case 'full':
      return stats.typeRange
        ? { lo: stats.typeRange[0], hi: stats.typeRange[1] }
        : { lo: stats.dataMin, hi: stats.dataMax }
    case 'fixed-0-80':
      return { lo: 0, hi: 80 }
    case 'suggested':
      return vol.suggestedRange ?? { lo: stats.dataMin, hi: stats.dataMax }
  }
}

export function pickInitialPreset(vol: Volume): Exclude<Preset, 'custom'> {
  const { stats } = vol
  if (stats.p2 === stats.p98) return 'full'
  // A deep negative floor paired with a wide positive extent means the data is
  // calibrated so that the fixed 0–80 window isolates the low-contrast mid-tones
  // a full-range map would flatten. The large negative plateau is exactly what a
  // full range would waste most of its span on, so default to the fixed window.
  if (stats.p2 <= -300 && stats.dataMin >= -3000 && stats.dataMax >= 200) {
    return 'fixed-0-80'
  }
  if (vol.datatypeCode === 2 && stats.dataMax <= 255 && stats.dataMax - stats.dataMin >= 128) {
    return 'full'
  }
  return 'auto'
}

/** Voxel-count fields stay whole (fractional margins would corrupt integer
 * box geometry) and grow's seed (high) stays >= boundary (low). `edited`
 * names the threshold the caller changed; on a crossing the other follows,
 * so the panel always shows exactly what will be computed. */
interface StoreLifecycle {
  prefStorage: Pick<Storage, 'getItem' | 'setItem'> | null
  pagehideTarget: PagehideTarget | null
  timers: AppStoreTimers
  previewClient: PreviewController
  modelController: ModelController
  confirmModelReplace(message: string): boolean
  dispose: () => void
}

function createAppState(
  lifecycle: StoreLifecycle,
  writeState: StoreApi<AppState>['setState'],
  get: StoreApi<AppState>['getState']
): AppState {
  const {
    prefStorage,
    pagehideTarget,
    timers,
    previewClient,
    modelController,
    confirmModelReplace
  } = lifecycle
  let disposed = false
  const set = ((...args: unknown[]): void => {
    if (!disposed) (writeState as (...values: unknown[]) => void)(...args)
  }) as StoreApi<AppState>['setState']
  // Every mutable lifecycle value below belongs to exactly this instance.
  // Layer ids stay unique across base changes inside one store.
  let nextOverlayId = 1
  let prefSaveTimer: ReturnType<typeof setTimeout> | undefined
  let pendingPrefSave: { path: string; pref: ViewPref } | null = null

  function clearPrefSaveTimer(): void {
    if (prefSaveTimer === undefined) return
    timers.clearTimeout(prefSaveTimer)
    prefSaveTimer = undefined
  }

  /** Write the pending capture immediately (idempotent). Runs on the timer,
   * from setVolume (a file switch inside the debounce window must neither
   * misattribute the save nor drop it), on pagehide, and during dispose. */
  function flushPrefSave(): void {
    clearPrefSaveTimer()
    if (!pendingPrefSave || !prefStorage) return
    saveViewPref(pendingPrefSave.path, pendingPrefSave.pref, prefStorage)
    pendingPrefSave = null
  }

  /** Debounced write of the current display range/preset to the per-file
   * prefs (drag gestures fire setRange every frame). Path and values are
   * captured NOW: the debounce only ever coalesces edits to the same file,
   * because setVolume flushes before the path can change. */
  function schedulePrefSave(): void {
    if (disposed || !prefStorage) return
    const s = get()
    if (!s.volume || !s.sourcePath) return
    pendingPrefSave = {
      path: s.sourcePath,
      pref: { preset: s.activePreset, lo: s.range.lo, hi: s.range.hi }
    }
    clearPrefSaveTimer()
    prefSaveTimer = timers.setTimeout(flushPrefSave, 300)
  }

  let uiPrefSaveTimer: ReturnType<typeof setTimeout> | undefined
  let pendingUiPrefSave: UiPrefs | null = null

  function clearUiPrefSaveTimer(): void {
    if (uiPrefSaveTimer === undefined) return
    timers.clearTimeout(uiPrefSaveTimer)
    uiPrefSaveTimer = undefined
  }

  function flushUiPrefSave(): void {
    clearUiPrefSaveTimer()
    if (!pendingUiPrefSave || !prefStorage) return
    saveUiPrefs(pendingUiPrefSave, prefStorage)
    pendingUiPrefSave = null
  }

  /** Debounced write of the panel layout (drag resizing fires per frame).
   * The payload is captured NOW so the dispose/pagehide flush is exact. */
  function scheduleUiPrefSave(): void {
    if (disposed || !prefStorage) return
    const s = get()
    pendingUiPrefSave = {
      tab: s.sidePanelTab,
      width: s.sidePanelWidth,
      collapsed: Object.keys(s.collapsedSections)
    }
    clearUiPrefSaveTimer()
    uiPrefSaveTimer = timers.setTimeout(flushUiPrefSave, 300)
  }

  /** Both debouncers together: the pagehide/dispose barrier. */
  function flushAllPrefSaves(): void {
    flushPrefSave()
    flushUiPrefSave()
  }

  function applyPanelWidth(px: number): void {
    const width = clampPanelWidth(px)
    if (get().sidePanelWidth === width) return
    set({ sidePanelWidth: width })
    scheduleUiPrefSave()
  }

  const initialUiPrefs = prefStorage ? loadUiPrefs(prefStorage) : defaultUiPrefs()

  const regionDomain = createRegionDomain({
    get: () => get(),
    set: (patch) => set(typeof patch === 'function' ? (state) => patch(state) : patch),
    timers,
    previewClient,
    modelController,
    confirmModelReplace
  })

  const state: AppState = {
    volume: null,
    volumeSession: 0,
    sourcePath: null,
    folder: null,
    folderLoading: false,
    filePanelOpen: true,
    sidePanelOpen: true,
    sidePanelTab: initialUiPrefs.tab,
    sidePanelWidth: initialUiPrefs.width,
    collapsedSections: Object.fromEntries(initialUiPrefs.collapsed.map((id) => [id, true])),
    directionLabelsVisible: true,
    crosshairVisible: true,
    pendingFilePath: null,
    loadState: 'empty',
    errorMessage: null,
    cross: [0, 0, 0],
    frame: 0,
    range: { lo: 0, hi: 1 },
    activePreset: 'auto',
    hover: null,
    renderMode: 'mip',
    density: 0.35,
    brightness: BRIGHTNESS_DEFAULT,
    baseColormap: 'gray',
    fileFilter: '',
    shortcutsOpen: false,
    overlays: [],
    ...regionDomain.state,

    startLoading: () => set({ loadState: 'loading', errorMessage: null }),

    // A fresh folder starts with an empty filter — a leftover query would
    // silently hide the new list.
    setFolder: (f) =>
      set((s) => ({
        folder: f,
        filePanelOpen: true,
        // A streaming scan calls this again with its final list; a filter
        // typed meanwhile must survive. Only a different folder resets it.
        fileFilter: s.folder && s.folder.root === f.root ? s.fileFilter : ''
      })),

    appendFolderFiles: (root, files) =>
      set((s) => {
        if (!s.folder || s.folder.root !== root) return {}
        // Batches never overlap, but dedup anyway so a stray repeat is inert.
        const seen = new Set(s.folder.files.map((f) => f.path))
        const fresh = files.filter((f) => !seen.has(f.path))
        if (fresh.length === 0) return {}
        return { folder: { ...s.folder, files: sortEntries([...s.folder.files, ...fresh]) } }
      }),

    closeFolder: () => set({ folder: null }),

    setFolderLoading: (b) => set({ folderLoading: b }),

    toggleFilePanel: () => set((s) => ({ filePanelOpen: !s.filePanelOpen })),

    toggleSidePanel: () => set((s) => ({ sidePanelOpen: !s.sidePanelOpen })),

    setSidePanelTab: (tab) => {
      if (get().sidePanelTab === tab) return
      set({ sidePanelTab: tab })
      scheduleUiPrefSave()
    },

    setSidePanelWidth: applyPanelWidth,

    resetSidePanelWidth: () => applyPanelWidth(SIDE_PANEL_WIDTH_DEFAULT),

    toggleSection: (id) => {
      set((s) => {
        const next = { ...s.collapsedSections }
        if (next[id]) delete next[id]
        else next[id] = true
        return { collapsedSections: next }
      })
      scheduleUiPrefSave()
    },

    toggleDirectionLabels: () =>
      set((s) => ({ directionLabelsVisible: !s.directionLabelsVisible })),

    toggleCrosshair: () => set((s) => ({ crosshairVisible: !s.crosshairVisible })),

    setPendingFilePath: (p) => set({ pendingFilePath: p }),

    setVolume: (v, sourcePath = null, settleLoad = true) => {
      const previousVolume = get().volume
      if (previousVolume && previousVolume !== v) releaseFrameTextureSource(previousVolume)
      const regionReset = regionDomain.resetForVolume()
      // The outgoing file's pending pref save must land under ITS path (and
      // before this file's pref is read back, in case it is the same file).
      flushPrefSave()
      // A remembered per-file preference wins over the load heuristic; the
      // custom preset restores its exact range, named presets re-derive from
      // this file's stats.
      const saved = sourcePath && prefStorage ? loadViewPref(sourcePath, prefStorage) : null
      let preset: Preset
      let range: { lo: number; hi: number }
      if (saved) {
        preset = saved.preset
        range =
          saved.preset === 'custom' ? { lo: saved.lo, hi: saved.hi } : presetRange(v, saved.preset)
      } else {
        const p = pickInitialPreset(v)
        preset = p
        range = presetRange(v, p)
      }
      set((s) => ({
        volume: v,
        volumeSession: s.volumeSession + 1,
        sourcePath,
        // A base volume from outside the opened folder replaces it entirely:
        // the file list only makes sense while browsing within that folder.
        folder:
          s.folder && sourcePath !== null && s.folder.files.some((f) => f.path === sourcePath)
            ? s.folder
            : null,
        loadState: settleLoad ? 'ready' : s.loadState,
        errorMessage: settleLoad ? null : s.errorMessage,
        cross: [Math.floor(v.dims[0] / 2), Math.floor(v.dims[1] / 2), Math.floor(v.dims[2] / 2)],
        frame: 0,
        range,
        activePreset: preset,
        hover: null,
        // A new base means a new grid: keeping layers would silently misalign
        // them, so they are dropped (also frees their memory promptly).
        overlays: [],
        ...regionReset
      }))
    },

    addOverlay: (v, settleLoad = true) => {
      const kind = guessOverlayKind(v)
      const { range, colormap } = defaultLayerSettings(v)
      const layer: OverlayLayer = {
        id: nextOverlayId++,
        volume: v,
        kind,
        visible: true,
        opacity: 0.6,
        range,
        colormap,
        hiddenLabels: new Set()
      }
      set((s) => ({
        overlays: [...s.overlays, layer],
        loadState: settleLoad ? 'ready' : s.loadState,
        errorMessage: settleLoad ? null : s.errorMessage
      }))
    },

    removeOverlay: (id) => {
      set((s) => ({ overlays: s.overlays.filter((l) => l.id !== id) }))
      regionDomain.overlayRemoved(id)
      // A constraint pointing at the removed layer would silently pin the
      // preview to stale data.
      const { segParams } = get()
      if (segParams.constraint.type === 'overlay' && segParams.constraint.overlayId === id) {
        get().setSegParams({ constraint: { type: 'none' } })
      }
    },

    updateOverlay: (id, patch) =>
      set((s) => ({
        overlays: s.overlays.map((l) => (l.id === id ? { ...l, ...patch } : l))
      })),

    fail: (message) =>
      set((s) => ({
        errorMessage: message,
        loadState: s.volume ? 'ready' : 'error'
      })),

    dismissError: () =>
      set((s) => ({ errorMessage: null, loadState: s.volume ? 'ready' : 'empty' })),

    setCross: (ijk) => {
      const vol = get().volume
      if (!vol) return
      set({
        cross: [
          Math.min(Math.max(ijk[0], 0), vol.dims[0] - 1),
          Math.min(Math.max(ijk[1], 0), vol.dims[1] - 1),
          Math.min(Math.max(ijk[2], 0), vol.dims[2] - 1)
        ]
      })
    },

    setFrame: (t) => {
      const s = get()
      const vol = s.volume
      if (!vol) return
      const frame = Math.min(Math.max(t, 0), vol.frames - 1)
      if (frame === s.frame) return
      set({ frame })
      regionDomain.frameChanged(s.segBox !== null)
    },

    setRange: (lo, hi) => {
      set({ range: { lo, hi }, activePreset: 'custom' })
      schedulePrefSave()
    },

    applyPreset: (p) => {
      const vol = get().volume
      if (!vol) return
      set({ range: presetRange(vol, p), activePreset: p })
      schedulePrefSave()
    },

    setHover: (h) => set({ hover: h }),

    setRenderMode: (m) => set({ renderMode: m }),

    setDensity: (d) => set({ density: Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, d)) }),

    setBrightness: (b) =>
      set({ brightness: Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, b)) }),

    setBaseColormap: (c) => set({ baseColormap: c }),

    setFileFilter: (q) => set({ fileFilter: q }),

    setShortcutsOpen: (open) => set({ shortcutsOpen: open })
  }

  lifecycle.dispose = (): void => {
    if (disposed) return
    // Persistence is part of teardown: do not silently drop the last edit.
    flushAllPrefSaves()
    const volume = get().volume
    if (volume) releaseFrameTextureSource(volume)
    disposed = true
    regionDomain.dispose()
    pagehideTarget?.removeEventListener('pagehide', flushAllPrefSaves)
  }
  pagehideTarget?.addEventListener('pagehide', flushAllPrefSaves)

  // `set` guards ordinary Zustand writes, but region actions also mutate
  // owned typed arrays before publishing a revision. Stable wrappers put the
  // lifecycle gate in front of every action so stale references are inert too.
  const actionRecord = state as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(actionRecord)) {
    if (typeof value !== 'function') continue
    const action = value as (...args: unknown[]) => unknown
    actionRecord[key] = (...args: unknown[]): unknown => (disposed ? undefined : action(...args))
  }

  return state
}

export function createAppStore(deps: AppStoreDeps = {}): AppStore {
  const openIntentGate = new OpenIntentGate()
  const lifecycle: StoreLifecycle = {
    prefStorage:
      deps.storage === undefined
        ? typeof localStorage === 'undefined'
          ? null
          : localStorage
        : deps.storage,
    pagehideTarget:
      deps.pagehideTarget === undefined
        ? typeof window === 'undefined'
          ? null
          : window
        : deps.pagehideTarget,
    timers: deps.timers ?? {
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (handle) => clearTimeout(handle)
    },
    previewClient: deps.createPreviewController?.() ?? new PreviewClient(),
    modelController: deps.createModelController?.() ?? new ModelRunner(),
    confirmModelReplace:
      deps.confirmModelReplace ??
      ((message) => (typeof window !== 'undefined' ? window.confirm(message) : false)),
    dispose: () => undefined
  }
  let disposed = false
  const api = createStore<AppState>((set, get) => createAppState(lifecycle, set, get))
  const rawSetState = api.setState
  api.setState = ((...args: unknown[]): void => {
    if (!disposed) (rawSetState as (...values: unknown[]) => void)(...args)
  }) as StoreApi<AppState>['setState']
  const rawSubscribe = api.subscribe
  const subscriptions = new Set<() => void>()
  api.subscribe = (listener) => {
    if (disposed) return () => undefined
    const rawUnsubscribe = rawSubscribe(listener)
    let active = true
    const unsubscribe = (): void => {
      if (!active) return
      active = false
      rawUnsubscribe()
      subscriptions.delete(unsubscribe)
    }
    subscriptions.add(unsubscribe)
    return unsubscribe
  }

  function useBoundStore(): AppState
  function useBoundStore<U>(selector: (state: AppState) => U): U
  function useBoundStore<U>(selector?: (state: AppState) => U): AppState | U {
    const select = (selector ?? identityState) as (state: AppState) => AppState | U
    return useZustandStore(api, select)
  }

  const store = Object.assign(useBoundStore, api)
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const unsubscribe of [...subscriptions]) unsubscribe()
    lifecycle.dispose()
  }
  return Object.assign(store, { dispose, openIntentGate })
}

/** Runtime singleton: components keep the existing bound-hook API. */
export const useStore = createAppStore()

/** Unsaved region edits exist (drives the replace/close confirmation).
 * Deleting the last region is still an unsaved edit — a previously exported
 * file would keep voxels the user just removed. */
export function hasUnsavedRegions(store: Pick<StoreApi<AppState>, 'getState'> = useStore): boolean {
  return store.getState().segDirty
}

// Hot replacement must release the old singleton's pagehide listener,
// timers, and lazily-created worker before the replacement module starts.
if (import.meta.hot) import.meta.hot.dispose(() => useStore.dispose())
