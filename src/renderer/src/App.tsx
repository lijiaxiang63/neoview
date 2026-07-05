import { useCallback, useEffect, useState, type JSX } from 'react'
import { useStore } from './store'
import { MAX_BYTES } from './volume/gunzip'
import { loadVolume } from './volume/loadVolume'
import { SliceView } from './components/SliceView'
import { VolumeView } from './components/VolumeView'
import { SidePanel } from './components/SidePanel'
import { Toolbar } from './components/Toolbar'
import { StatusBar } from './components/StatusBar'
import { EmptyState } from './components/EmptyState'

async function loadFromBuffer(name: string, buf: ArrayBuffer): Promise<void> {
  const store = useStore.getState()
  store.startLoading()
  try {
    const volume = await loadVolume(name, buf)
    useStore.getState().setVolume(volume)
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
  const [dragging, setDragging] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const openDialog = useCallback(async () => {
    const opened = await window.neoview.openDialog()
    if (opened) await loadFromBuffer(opened.name, opened.bytes)
  }, [])

  useEffect(() => {
    const offOpened = window.neoview.onFileOpened((file) => {
      void loadFromBuffer(file.name, file.bytes)
    })
    const offError = window.neoview.onFileOpenError((message) => {
      useStore.getState().fail(message)
    })
    return () => {
      offOpened()
      offError()
    }
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
    const onDragOver = (e: DragEvent): void => {
      e.preventDefault()
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
      void file.arrayBuffer().then((buf) => loadFromBuffer(file.name, buf))
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
      <main className={`workspace${sidebarOpen ? '' : ' sidebar-closed'}`}>
        {hasVolume ? (
          <>
            <SliceView view={0} />
            <SliceView view={1} />
            <SliceView view={2} />
            <VolumeView />
            <SidePanel />
          </>
        ) : (
          <EmptyState onOpen={openDialog} />
        )}
      </main>
      <StatusBar />
      {dragging && (
        <div className="drag-overlay">
          <div className="inner">Release to open</div>
        </div>
      )}
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
