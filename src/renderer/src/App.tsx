import { useCallback, useEffect, useState, type JSX } from 'react'
import { hasUnsavedRegions, useStore } from './store'
import { MAX_BYTES } from './volume/gunzip'
import { loadVolume } from './volume/loadVolume'
import { composeVoxelMap } from './volume/affine'
import type { Volume } from './volume/types'
import { LoadCoordinator } from './files/loadCoordinator'
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

// All load/scan orchestration — who may commit, who settles the loading
// flag, navigation queueing, prefetching, scan tokens and invalidation —
// lives in the coordinator, a pure module whose interleavings are
// unit-tested (tests/loadCoordinator.test.ts). This file only wires its
// effects to the store, the preload bridge, and the parser.
const coordinator = new LoadCoordinator<Volume>({
  snapshot: () => {
    const s = useStore.getState()
    return {
      sourcePath: s.sourcePath,
      loading: s.loadState === 'loading',
      scanning: s.folderLoading,
      folderRoot: s.folder?.root ?? null,
      folderFiles: s.folder?.files ?? null
    }
  },
  read: (path) => window.neoview.readFile(path),
  readWithin: (path, maxBytes) => window.neoview.readFileWithin(path, maxBytes),
  parseBase: (name, bytes) => loadVolume(name, bytes),
  commitBase: (volume, path) => useStore.getState().setVolume(volume, path),
  parseAndAddOverlay: async (name, bytes) => {
    const volume = await loadVolume(name, bytes, { skipTex: true })
    const base = useStore.getState().volume
    if (!base) {
      useStore.getState().fail('Load the base volume first.')
    } else if (!composeVoxelMap(base.affine, volume.affine)) {
      useStore.getState().fail('Overlay could not be aligned: its affine is not invertible.')
    } else {
      useStore.getState().addOverlay(volume)
    }
  },
  confirmReplaceBase: confirmDiscardRegionWork,
  raiseLoading: () => useStore.getState().startLoading(),
  dismissLoading: () => useStore.getState().dismissError(),
  failParse: (err) =>
    useStore.getState().fail(err instanceof Error ? err.message : 'Could not open file.'),
  failRead: (err) => useStore.getState().fail(ipcErrorMessage(err)),
  setPending: (p) => useStore.getState().setPendingFilePath(p),
  setFolder: (f) => useStore.getState().setFolder(f),
  appendFolder: (root, files) => useStore.getState().appendFolderFiles(root, files),
  setScanning: (b) => useStore.getState().setFolderLoading(b)
})

// The folder closing (e.g. an outside file replaced it) releases the cached
// prefetch bytes instead of pinning them until the next navigation.
useStore.subscribe((s) => {
  if (s.folder === null) coordinator.releasePrefetch()
})

// Covers the picker as well as the scan, so a double-click on the button (or
// button + menu) cannot stack two dialogs.
let folderFlowActive = false

/** Main-owned picker + scan → folder mode, with loading feedback and a
 * re-entry guard (big folders take a moment to scan). */
async function openFolderViaDialog(): Promise<void> {
  if (folderFlowActive || useStore.getState().folderLoading) return
  folderFlowActive = true
  try {
    await coordinator.scanFolder((token) => window.neoview.openFolderScan(token))
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
    await coordinator.openBase(opened.name, opened.bytes, opened.path)
  }, [])

  const addOverlayViaDialog = useCallback(async () => {
    const opened = await window.neoview.openDialog()
    if (opened) await coordinator.openOverlay(opened.name, opened.bytes)
  }, [])

  const openFolder = useCallback(() => void openFolderViaDialog(), [])

  useEffect(() => {
    const offOpened = window.neoview.onFileOpened((file) => {
      void coordinator.openBase(file.name, file.bytes, file.path)
    })
    const offError = window.neoview.onFileOpenError((message) => {
      useStore.getState().fail(message)
    })
    const offFolder = window.neoview.onOpenFolderRequest(() => {
      void openFolderViaDialog()
    })
    const offScan = window.neoview.onScanFolderProgress((token, root, files) =>
      coordinator.onScanBatch(token, root, files)
    )
    // The main process holds every close until the renderer confirms, so
    // unexported region edits — and a drawn-but-uncommitted box — get a
    // chance to veto it (same guard as replacing the base volume).
    const offClose = window.neoview.onCloseRequested(() => {
      if (confirmDiscardRegionWork()) {
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
        coordinator.navigate(e.key === 'ArrowDown' ? 1 : -1)
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
        // probe comes first: entering scanFolder marks a running scan
        // stale, which a plain-file drop must never do.
        if (path && (await window.neoview.isDirectory(path).catch(() => false))) {
          try {
            if (
              await coordinator.scanFolder((token) => window.neoview.scanDroppedFolder(file, token))
            ) {
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
        const buf = await file.arrayBuffer()
        // openBase abandons a still-running scan itself: a dropped file that
        // replaces the base wins over the scan.
        if (resolvedTarget === 'base') await coordinator.openBase(file.name, buf, path)
        else await coordinator.openOverlay(file.name, buf)
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
        {folderOpen && filePanelOpen && (
          <FilePanel onSelect={(entry) => coordinator.requestEntry(entry.path)} />
        )}
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
