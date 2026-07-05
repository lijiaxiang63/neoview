import { useCallback, useEffect, useState, type JSX } from 'react'
import { hasUnsavedRegions, useStore } from './store'
import { MAX_BYTES } from './volume/gunzip'
import { loadVolume } from './volume/loadVolume'
import { composeVoxelMap } from './volume/affine'
import { SliceView } from './components/SliceView'
import { VolumeView } from './components/VolumeView'
import { SidePanel } from './components/SidePanel'
import { Toolbar } from './components/Toolbar'
import { StatusBar } from './components/StatusBar'
import { EmptyState } from './components/EmptyState'
import { Toast } from './components/Toast'

/** 'auto' routes to an overlay layer when a base volume is already loaded. */
type LoadTarget = 'base' | 'overlay' | 'auto'

const UNSAVED_WARNING =
  'There are region edits that have not been exported. They will be lost. Continue?'

async function loadFromBuffer(
  name: string,
  buf: ArrayBuffer,
  target: LoadTarget,
  path: string | null = null
): Promise<void> {
  const store = useStore.getState()
  const asOverlay = target === 'overlay' || (target === 'auto' && store.volume !== null)
  if (!asOverlay && hasUnsavedRegions() && !window.confirm(UNSAVED_WARNING)) return
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
      useStore.getState().setVolume(volume, path)
    }
  } catch (err) {
    useStore.getState().fail(err instanceof Error ? err.message : 'Could not open file.')
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
  const [dragging, setDragging] = useState(false)
  const [dropTarget, setDropTarget] = useState<LoadTarget>('auto')
  const [sidebarOpen, setSidebarOpen] = useState(true)

  // Explicit Open always replaces the base volume (the one way to swap it);
  // drops route to an overlay layer whenever a base is already present.
  const openDialog = useCallback(async () => {
    const opened = await window.neoview.openDialog()
    if (opened) await loadFromBuffer(opened.name, opened.bytes, 'base', opened.path)
  }, [])

  const addOverlayViaDialog = useCallback(async () => {
    const opened = await window.neoview.openDialog()
    if (opened) await loadFromBuffer(opened.name, opened.bytes, 'overlay')
  }, [])

  useEffect(() => {
    const offOpened = window.neoview.onFileOpened((file) => {
      void loadFromBuffer(file.name, file.bytes, 'base', file.path)
    })
    const offError = window.neoview.onFileOpenError((message) => {
      useStore.getState().fail(message)
    })
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
      offClose()
    }
  }, [])

  // Segmentation keyboard shortcuts (skip while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
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
      }
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
      if (!acceptsName(file.name)) {
        useStore.getState().fail(`"${file.name}" is not a .nii or .nii.gz file.`)
        return
      }
      if (file.size > MAX_BYTES) {
        useStore.getState().fail('File is larger than 2 GB, which is not supported.')
        return
      }
      const target = zoneAt(e)
      const path = window.neoview.pathForFile(file) || null
      void file.arrayBuffer().then((buf) => loadFromBuffer(file.name, buf, target, path))
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
      {loadState === 'loading' && <div className="loading-bar" />}
      <Toolbar
        onOpen={openDialog}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
      />
      <main
        className={`workspace${sidebarOpen ? '' : ' sidebar-closed'}${hasMaximized ? ' has-max' : ''}`}
      >
        {hasVolume ? (
          <>
            <SliceView view={0} />
            <SliceView view={1} />
            <SliceView view={2} />
            <VolumeView />
            <SidePanel onAddOverlay={addOverlayViaDialog} />
          </>
        ) : (
          <EmptyState onOpen={openDialog} />
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
