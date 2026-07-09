import { useCallback, useEffect, useState, type JSX } from 'react'
import { hasUnsavedRegions, useStore } from './store'
import { MAX_BYTES } from './volume/gunzip'
import { loadVolume } from './volume/loadVolume'
import { composeVoxelMap } from './volume/affine'
import type { Volume } from './volume/types'
import { LoadCoordinator } from './files/loadCoordinator'
import { filterEntries, regionExportSource, regionExportView } from './files/folderList'
import { SliceView } from './components/SliceView'
import { VolumeView } from './components/VolumeView'
import { SidePanel } from './components/SidePanel'
import { StatusBar } from './components/StatusBar'
import { EmptyState } from './components/EmptyState'
import { FilePanel } from './components/FilePanel'
import { NotificationCenter } from './components/NotificationCenter'
import { ShortcutsOverlay } from './components/ShortcutsOverlay'

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
const coordinator = new LoadCoordinator<Volume>(
  {
    snapshot: () => {
      const s = useStore.getState()
      return {
        sourcePath: s.sourcePath,
        loading: s.loadState === 'loading',
        scanning: s.folderLoading,
        folderRoot: s.folder?.root ?? null,
        // The coordinator sees the list as the panel shows it — with region
        // exports folded away and the file filter applied — so navigation,
        // prefetch and the folder's auto-load all match what the user sees.
        folderFiles: s.folder
          ? filterEntries(regionExportView(s.folder.files).files, s.fileFilter)
          : null
      }
    },
    read: (path) => window.neoview.readFile(path),
    readWithin: (path, maxBytes) => window.neoview.readFileWithin(path, maxBytes),
    parseBase: (name, bytes) => loadVolume(name, bytes),
    commitBase: (volume, path) => {
      useStore.getState().setVolume(volume, path)
      // Feeds File > Open Recent (and the OS recent-documents list).
      if (path) window.neoview.noteFileOpened(path)
    },
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
  },
  {
    // An export product stays visible only until its source volume streams in
    // (regionExportView folds it away), so a partial batch must never
    // auto-load one — the final scan decides whether it is a real entry.
    deferAutoLoad: (f) => regionExportSource(f.name) !== null
  }
)

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
  // Plain .gz is accepted to match the open dialog's filter — the loader
  // detects gzip by signature, so the inner payload decides validity.
  return n.endsWith('.nii') || n.endsWith('.gz')
}

export default function App(): JSX.Element {
  const loadState = useStore((s) => s.loadState)
  const hasVolume = useStore((s) => s.volume !== null)
  const volumeName = useStore((s) => s.volume?.name ?? null)
  const hasMaximized = useStore((s) => s.maximizedView !== null)
  const folderOpen = useStore((s) => s.folder !== null)
  const folderLoading = useStore((s) => s.folderLoading)
  const filePanelOpen = useStore((s) => s.filePanelOpen)
  const sidebarOpen = useStore((s) => s.sidePanelOpen)
  const [dragging, setDragging] = useState(false)
  const [dropTarget, setDropTarget] = useState<LoadTarget>('auto')
  const shortcutsOpen = useStore((s) => s.shortcutsOpen)
  const setShortcutsOpen = useStore((s) => s.setShortcutsOpen)

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

  // The title bar is the only place the loaded file's name shows now that
  // there is no in-app toolbar.
  useEffect(() => {
    document.title = volumeName ? `${volumeName} — neoview` : 'neoview'
  }, [volumeName])

  // The View menu drives the panel toggles; every relevant store change is
  // mirrored back so the menu's checkboxes (and enabled state) track it.
  useEffect(() => {
    const offFilePanel = window.neoview.onToggleFilePanel(() =>
      useStore.getState().toggleFilePanel()
    )
    const offSidePanel = window.neoview.onToggleSidePanel(() =>
      useStore.getState().toggleSidePanel()
    )
    let last = ''
    const sync = (): void => {
      const s = useStore.getState()
      const state = {
        fileList: s.filePanelOpen,
        sidePanel: s.sidePanelOpen,
        folderOpen: s.folder !== null
      }
      const key = `${state.fileList}|${state.sidePanel}|${state.folderOpen}`
      if (key === last) return
      last = key
      window.neoview.sendViewState(state)
    }
    sync()
    const unsub = useStore.subscribe(sync)
    return () => {
      offFilePanel()
      offSidePanel()
      unsub()
    }
  }, [])

  useEffect(() => {
    const offOpened = window.neoview.onFileOpened((file) => {
      // A bundled sample arrives with an empty path (no user source); pass null
      // so region export prompts for a folder instead of defaulting into the
      // read-only app bundle.
      void coordinator.openBase(file.name, file.bytes, file.path || null)
    })
    const offOverlay = window.neoview.onOverlayOpened((file) => {
      void coordinator.openOverlay(file.name, file.bytes)
    })
    const offError = window.neoview.onFileOpenError((message) => {
      useStore.getState().fail(message)
    })
    const offFolder = window.neoview.onOpenFolderRequest(() => {
      void openFolderViaDialog()
    })
    const offShortcuts = window.neoview.onShowShortcuts(() =>
      useStore.getState().setShortcutsOpen(true)
    )
    // macOS routes Cmd+Z / Shift+Cmd+Z through the Edit menu; a focused text
    // field keeps its own undo, everything else drives region-edit history.
    const isTextTarget = (): boolean => {
      const el = document.activeElement
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
    }
    const offUndo = window.neoview.onMenuUndo(() => {
      if (isTextTarget()) document.execCommand('undo')
      else useStore.getState().undo()
    })
    const offRedo = window.neoview.onMenuRedo(() => {
      if (isTextTarget()) document.execCommand('redo')
      else useStore.getState().redo()
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
      } else {
        window.neoview.cancelClose()
      }
    })
    return () => {
      offOpened()
      offOverlay()
      offError()
      offFolder()
      offShortcuts()
      offUndo()
      offRedo()
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
      } else if (e.key === '?') {
        st.setShortcutsOpen(true)
      } else if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'z') {
        // On macOS the Edit menu's accelerators own these keys; this branch
        // serves Windows/Linux (text fields bail out at the tag guard above).
        if (e.shiftKey) st.redo()
        else st.undo()
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
      <NotificationCenter />
      {shortcutsOpen && <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
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
    </div>
  )
}
