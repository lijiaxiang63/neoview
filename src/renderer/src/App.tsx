import { useCallback, useEffect, useState, type JSX } from 'react'
import { hasUnsavedRegions, useStore } from './store'
import { MAX_BYTES } from './volume/gunzip'
import { loadVolume } from './volume/loadVolume'
import { composeVoxelMap } from './volume/affine'
import { adjacentIndex, isUnderRoot, sortEntries, type FolderEntry } from './files/folderList'
import { SliceView } from './components/SliceView'
import { VolumeView } from './components/VolumeView'
import { SidePanel } from './components/SidePanel'
import { Toolbar } from './components/Toolbar'
import { StatusBar } from './components/StatusBar'
import { EmptyState } from './components/EmptyState'
import { FilePanel } from './components/FilePanel'
import { Toast } from './components/Toast'

/** 'auto' routes to an overlay layer when a base volume is already loaded. */
type LoadTarget = 'base' | 'overlay' | 'auto'

const UNSAVED_WARNING =
  'There are region edits that have not been exported. They will be lost. Continue?'
const UNCOMMITTED_WARNING =
  'There is a drawn region that has not been committed. It will be lost. Continue?'

/** Replacing the base drops region work; committed edits and a still-drawn
 * box both deserve a veto. */
function confirmDiscardRegionWork(): boolean {
  if (hasUnsavedRegions()) return window.confirm(UNSAVED_WARNING)
  if (useStore.getState().segBox) return window.confirm(UNCOMMITTED_WARNING)
  return true
}

/** Invoke rejections arrive wrapped in Electron's remote-method prefix. */
function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : 'Could not open file.'
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

// Every base load takes a fresh generation and checks it again at commit
// time: parsing takes seconds, and two loads can be in flight at once (a
// queued folder navigation and an explicit open). Whichever started LAST
// owns the view — the older parse discards its result instead of
// committing over it. loadFromBuffer is the only path that replaces the
// base, so this one gate covers dialog, menu, drop, and folder navigation.
let baseLoadGen = 0

async function loadFromBuffer(
  name: string,
  buf: ArrayBuffer,
  target: LoadTarget,
  path: string | null = null,
  // Extra commit-time veto for callers whose intent can go stale while the
  // parse runs (folder navigation: the queued target may have moved on —
  // that does not start another base load, so the generation alone misses it).
  isStale?: () => boolean
): Promise<void> {
  const store = useStore.getState()
  const asOverlay = target === 'overlay' || (target === 'auto' && store.volume !== null)
  if (!asOverlay && !confirmDiscardRegionWork()) return
  const gen = asOverlay ? null : ++baseLoadGen
  store.startLoading()
  try {
    if (asOverlay) {
      const volume = await loadVolume(name, buf, { skipTex: true })
      const base = useStore.getState().volume
      if (!base) {
        useStore.getState().fail('Load the base volume first.')
      } else if (!composeVoxelMap(base.affine, volume.affine)) {
        useStore.getState().fail('Overlay could not be aligned: its affine is not invertible.')
      } else {
        useStore.getState().addOverlay(volume)
      }
    } else {
      const volume = await loadVolume(name, buf)
      if (gen !== baseLoadGen) return // a newer base load owns the view
      if (isStale?.()) return // the caller's intent moved on mid-parse
      useStore.getState().setVolume(volume, path)
    }
  } catch (err) {
    // A superseded load's failure is not the current view's problem.
    if (gen !== null && gen !== baseLoadGen) return
    useStore.getState().fail(err instanceof Error ? err.message : 'Could not open file.')
  }
}

// ---- Folder navigation --------------------------------------------------
// Arrow keys repeat much faster than a volume loads, so navigation is a
// queue of one: key presses only move the target (shown as the pending row
// in the list); the pump below loads whatever the target is once the
// current load settles, discarding reads that went stale along the way.
// Holding a key therefore scrubs to a destination instead of grinding
// through every file in between.
let queuedPath: string | null = null
let entryPumpActive = false

// One-slot byte cache for the file the next key press most likely wants
// (the neighbor in the last direction travelled). Consuming a hit skips the
// disk read — the slowest step on external drives.
let prefetched: { path: string; bytes: ArrayBuffer } | null = null
let prefetchActive = false
let lastDelta: 1 | -1 = 1
// Bigger prefetches are dropped: the read still warmed the OS page cache,
// so the real read stays fast without pinning huge buffers.
const PREFETCH_KEEP_MAX = 512 * 1024 * 1024

// The folder closing (e.g. an outside file replaced it) releases the cached
// bytes instead of pinning them until the next navigation.
useStore.subscribe((s) => {
  if (s.folder === null) prefetched = null
})

function requestFolderEntry(entry: FolderEntry): void {
  queuedPath = entry.path
  useStore.getState().setPendingFilePath(entry.path)
  void pumpEntryLoads()
}

async function pumpEntryLoads(): Promise<void> {
  if (entryPumpActive) return
  entryPumpActive = true
  try {
    while (queuedPath) {
      const st = useStore.getState()
      const path = queuedPath
      if (path === st.sourcePath) break
      const entry = st.folder?.files.find((f) => f.path === path)
      if (!entry) break
      try {
        let opened: { name: string; path: string; bytes: ArrayBuffer }
        if (prefetched && prefetched.path === path) {
          opened = { name: entry.name, path, bytes: prefetched.bytes }
          prefetched = null // the load transfers the buffer away
        } else {
          opened = await window.neoview.readFile(path)
          // The target moved on while this file was being read: drop the
          // bytes unparsed and chase the newer target.
          if (queuedPath !== path) continue
          // An explicit open may have started or landed meanwhile — the
          // user's choice wins over stale folder navigation.
          const now = useStore.getState()
          if (
            now.loadState === 'loading' ||
            now.sourcePath !== st.sourcePath ||
            !now.folder?.files.some((f) => f.path === path)
          ) {
            break
          }
        }
        // The veto keeps a slow parse from flashing an intermediate file
        // when the queued target moved on (prefetched bytes skip the read,
        // so the pre-parse checks alone cannot catch that).
        await loadFromBuffer(opened.name, opened.bytes, 'base', opened.path, () => {
          return queuedPath !== path
        })
      } catch (err) {
        useStore.getState().fail(ipcErrorMessage(err))
        break
      }
      if (queuedPath === path) break
    }
  } finally {
    queuedPath = null
    entryPumpActive = false
    useStore.getState().setPendingFilePath(null)
    schedulePrefetch()
  }
}

/** After navigation settles, read the neighbor in the direction of travel so
 * the next key press starts from parsing instead of the disk. */
function schedulePrefetch(): void {
  if (prefetchActive) return
  const st = useStore.getState()
  if (!st.folder || st.sourcePath === null) return
  const idx = adjacentIndex(st.folder.files, st.sourcePath, lastDelta)
  if (idx === null) return
  const target = st.folder.files[idx]
  if (prefetched?.path === target.path) return
  prefetchActive = true
  window.neoview
    .readFile(target.path)
    .then((opened) => {
      const cur = useStore.getState()
      const relevant = cur.folder?.files.some((f) => f.path === opened.path) ?? false
      if (relevant && opened.bytes.byteLength <= PREFETCH_KEEP_MAX) {
        prefetched = { path: opened.path, bytes: opened.bytes }
      }
    })
    .catch(() => {
      // Prefetch is opportunistic; the real read will surface any error.
    })
    .finally(() => {
      prefetchActive = false
    })
}

/** Move the navigation target to the previous/next file (no wrap). */
function navigateFolder(delta: 1 | -1): void {
  const s = useStore.getState()
  if (!s.folder) return
  lastDelta = delta
  const idx = adjacentIndex(s.folder.files, queuedPath ?? s.sourcePath, delta)
  if (idx !== null) requestFolderEntry(s.folder.files[idx])
}

// Bumped whenever a scan starts or is abandoned. Doubles as the scan token:
// the main process echoes it in every progress batch, so anything not
// carrying the current generation is a superseded scan and gets ignored.
let scanGen = 0
// Armed when a scan starts; the first non-empty view of the folder consumes
// it, so the folder's first file loads exactly once (batches keep streaming
// afterwards without re-prompting anyone who declined the region confirm).
let folderAutoLoad = false

/** An explicit user action (File > Open, a drop) supersedes a running scan:
 * its remaining batches and final result are ignored rather than fighting
 * the user's choice. The main-process scan just runs out harmlessly. */
function abandonActiveScan(): void {
  scanGen++
  folderAutoLoad = false
  useStore.getState().setFolderLoading(false)
}

function maybeAutoLoad(final: boolean): void {
  if (!folderAutoLoad) return
  const st = useStore.getState()
  if (!st.folder || st.folder.files.length === 0) return
  const src = st.sourcePath
  // A loaded file that sits under the root may simply not have streamed in
  // yet — deciding to replace it belongs to the final scan, not a batch.
  if (!final && src !== null && isUnderRoot(st.folder.root, src)) return
  folderAutoLoad = false
  if (!st.folder.files.some((f) => f.path === src)) {
    requestFolderEntry(st.folder.files[0])
  }
}

/** A streamed scan batch arrived: create or grow the folder it belongs to.
 * The token gate is what keeps a superseded scan (still streaming in the
 * main process) from mutating the list the newer scan now owns. */
function onScanBatch(token: number, root: string, files: FolderEntry[]): void {
  if (token !== scanGen) return
  const st = useStore.getState()
  if (st.folder && st.folder.root === root) {
    st.appendFolderFiles(root, files)
  } else {
    st.setFolder({ root, files: sortEntries(files), truncated: false })
  }
  maybeAutoLoad(false)
}

/** Run a scan into folder mode; false when the source is not a directory.
 * The list fills from streamed batches while the scan runs; the resolved
 * scan is the authoritative final state (unless the scan was abandoned). */
async function scanIntoFolder(
  scan: (token: number) => Promise<{
    root: string
    files: FolderEntry[]
    truncated: boolean
  } | null>
): Promise<boolean> {
  const gen = ++scanGen
  folderAutoLoad = true
  useStore.getState().setFolderLoading(true)
  try {
    const result = await scan(gen)
    if (gen !== scanGen) return true // superseded by an explicit open
    if (!result) return false
    useStore.getState().setFolder({
      root: result.root,
      files: sortEntries(result.files),
      truncated: result.truncated
    })
    maybeAutoLoad(true)
    return true
  } finally {
    if (gen === scanGen) {
      folderAutoLoad = false
      useStore.getState().setFolderLoading(false)
    }
  }
}

// Covers the picker as well as the scan, so a double-click on the button (or
// button + menu) cannot stack two dialogs.
let folderFlowActive = false

/** Main-owned picker + scan → folder mode, with loading feedback and a
 * re-entry guard (big folders take a moment to scan). */
async function openFolderViaDialog(): Promise<void> {
  if (folderFlowActive || useStore.getState().folderLoading) return
  folderFlowActive = true
  try {
    await scanIntoFolder((token) => window.neoview.openFolderScan(token))
  } catch (err) {
    useStore.getState().fail(ipcErrorMessage(err))
  } finally {
    folderFlowActive = false
  }
}

function acceptsName(name: string): boolean {
  const n = name.toLowerCase()
  return n.endsWith('.nii') || n.endsWith('.nii.gz') || n.endsWith('.gz')
}

export default function App(): JSX.Element {
  const loadState = useStore((s) => s.loadState)
  const errorMessage = useStore((s) => s.errorMessage)
  const dismissError = useStore((s) => s.dismissError)
  const hasVolume = useStore((s) => s.volume !== null)
  const hasMaximized = useStore((s) => s.maximizedView !== null)
  const folderOpen = useStore((s) => s.folder !== null)
  const folderLoading = useStore((s) => s.folderLoading)
  const filePanelOpen = useStore((s) => s.filePanelOpen)
  const [dragging, setDragging] = useState(false)
  const [dropTarget, setDropTarget] = useState<LoadTarget>('auto')
  const [sidebarOpen, setSidebarOpen] = useState(true)

  // Explicit Open always replaces the base volume (the one way to swap it);
  // drops route to an overlay layer whenever a base is already present.
  const openDialog = useCallback(async () => {
    const opened = await window.neoview.openDialog()
    if (!opened) return
    // A completed explicit pick wins over a folder scan still in flight.
    if (useStore.getState().folderLoading) abandonActiveScan()
    await loadFromBuffer(opened.name, opened.bytes, 'base', opened.path)
  }, [])

  const addOverlayViaDialog = useCallback(async () => {
    const opened = await window.neoview.openDialog()
    if (opened) await loadFromBuffer(opened.name, opened.bytes, 'overlay')
  }, [])

  const openFolder = useCallback(() => void openFolderViaDialog(), [])

  useEffect(() => {
    const offOpened = window.neoview.onFileOpened((file) => {
      // File > Open completed while a folder scan was running: the explicit
      // pick wins — the scan is abandoned, never the user's file.
      if (useStore.getState().folderLoading) abandonActiveScan()
      void loadFromBuffer(file.name, file.bytes, 'base', file.path)
    })
    const offError = window.neoview.onFileOpenError((message) => {
      useStore.getState().fail(message)
    })
    const offFolder = window.neoview.onOpenFolderRequest(() => {
      void openFolderViaDialog()
    })
    const offScan = window.neoview.onScanFolderProgress(onScanBatch)
    // The main process holds every close until the renderer confirms, so
    // unexported region edits get a chance to veto it.
    const offClose = window.neoview.onCloseRequested(() => {
      if (!hasUnsavedRegions() || window.confirm(UNSAVED_WARNING)) {
        window.neoview.confirmClose()
      }
    })
    return () => {
      offOpened()
      offError()
      offFolder()
      offScan()
      offClose()
    }
  }, [])

  // Segmentation keyboard shortcuts (skip while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Controls that already consumed the key (e.g. the range-slider thumbs,
      // which are divs the tag guard below cannot catch) must win.
      if (e.defaultPrevented) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      const st = useStore.getState()
      if (e.key === 'Escape' && st.segBox) {
        st.cancelSeg()
      } else if (e.key === 'Escape' && st.maximizedView !== null) {
        st.toggleMaximized(st.maximizedView)
      } else if (e.key === 'Enter' && st.segBox) {
        // No preview guard here: the preview may still be inside its debounce
        // window; commitPreview folds pending edits in and no-ops on empty.
        st.commitPreview()
      } else if (e.key === '[') {
        st.setBrushRadius(st.brushRadius - 1)
      } else if (e.key === ']') {
        st.setBrushRadius(st.brushRadius + 1)
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && st.folder) {
        navigateFolder(e.key === 'ArrowDown' ? 1 : -1)
      } else {
        return
      }
      // A focused control must not also act on the handled keystroke (e.g.
      // Enter re-activating the Box tool button right after the commit).
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    let depth = 0
    const onDragEnter = (e: DragEvent): void => {
      if (!e.dataTransfer?.types.includes('Files')) return
      depth++
      setDragging(true)
    }
    const onDragLeave = (): void => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    // With a base volume loaded, the drag overlay splits into two drop zones;
    // which one the pointer is over decides between replacing the base and
    // adding an overlay layer.
    const zoneAt = (e: DragEvent): LoadTarget => {
      const zone = (e.target as HTMLElement | null)?.closest?.('[data-drop-target]')
      const t = zone instanceof HTMLElement ? zone.dataset.dropTarget : undefined
      return t === 'base' || t === 'overlay' ? t : 'auto'
    }
    const onDragOver = (e: DragEvent): void => {
      e.preventDefault()
      setDropTarget(zoneAt(e))
    }
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      const file = e.dataTransfer?.files[0]
      if (!file) return
      const target = zoneAt(e)
      const path = window.neoview.pathForFile(file) || null
      // Resolve 'auto' synchronously at drop time: it must reflect what the
      // drag overlay showed the user, not the store as it looks after the
      // awaits below (a folder auto-load committing meanwhile would flip a
      // base-intent drop into an overlay).
      const resolvedTarget: LoadTarget =
        target === 'auto' ? (useStore.getState().volume ? 'overlay' : 'base') : target
      void (async () => {
        // A dropped directory enters folder mode regardless of the drop zone
        // (a fresh scan supersedes any scan already running). The read-only
        // probe comes first: entering scanIntoFolder marks a running scan
        // stale, which a plain-file drop must never do.
        if (path && (await window.neoview.isDirectory(path).catch(() => false))) {
          try {
            if (await scanIntoFolder((token) => window.neoview.scanDroppedFolder(file, token))) {
              return
            }
          } catch (err) {
            useStore.getState().fail(ipcErrorMessage(err))
            return
          }
        }
        if (!acceptsName(file.name)) {
          useStore.getState().fail(`"${file.name}" is not a .nii or .nii.gz file.`)
          return
        }
        if (file.size > MAX_BYTES) {
          useStore.getState().fail('File is larger than 2 GB, which is not supported.')
          return
        }
        // A dropped file that will replace the base wins over a running scan.
        if (resolvedTarget === 'base' && useStore.getState().folderLoading) {
          abandonActiveScan()
        }
        const buf = await file.arrayBuffer()
        await loadFromBuffer(file.name, buf, resolvedTarget, path)
      })()
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return (
    <div className="app">
      {(loadState === 'loading' || folderLoading) && <div className="loading-bar" />}
      <Toolbar
        onOpen={openDialog}
        onOpenFolder={openFolder}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
      />
      <main
        className={`workspace${folderOpen && filePanelOpen ? ' has-files' : ''}${sidebarOpen ? '' : ' sidebar-closed'}${hasMaximized ? ' has-max' : ''}`}
      >
        {folderOpen && filePanelOpen && <FilePanel onSelect={requestFolderEntry} />}
        {hasVolume ? (
          <>
            <SliceView view={0} />
            <SliceView view={1} />
            <SliceView view={2} />
            <VolumeView />
            <SidePanel onAddOverlay={addOverlayViaDialog} />
          </>
        ) : (
          <EmptyState onOpen={openDialog} onOpenFolder={openFolder} />
        )}
      </main>
      <StatusBar />
      <Toast />
      {dragging &&
        (hasVolume ? (
          <div className="drag-overlay split">
            <div
              className={`drop-zone${dropTarget === 'base' ? ' hot' : ''}`}
              data-drop-target="base"
            >
              <div className="inner">Replace volume</div>
            </div>
            <div
              className={`drop-zone${dropTarget !== 'base' ? ' hot' : ''}`}
              data-drop-target="overlay"
            >
              <div className="inner">Add overlay</div>
            </div>
          </div>
        ) : (
          <div className="drag-overlay">
            <div className="inner">Release to open</div>
          </div>
        ))}
      {errorMessage && (
        <div className="error-banner">
          <span className="msg">{errorMessage}</span>
          <button onClick={dismissError} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
