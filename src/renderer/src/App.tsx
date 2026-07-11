import { useSyncExternalStore, type JSX } from 'react'
import { useStore } from './store'
import type { RendererRuntime } from './runtime/rendererRuntime'
import { SliceView } from './components/SliceView'
import { VolumeView } from './components/VolumeView'
import { SidePanel } from './components/SidePanel'
import { StatusBar } from './components/StatusBar'
import { EmptyState } from './components/EmptyState'
import { FilePanel } from './components/FilePanel'
import { NotificationCenter } from './components/NotificationCenter'
import { ShortcutsOverlay } from './components/ShortcutsOverlay'
import type { RegionExportController } from './runtime/regionExportController'
import type { UpdatePresenter } from './runtime/updatePresenter'

interface Props {
  runtime: RendererRuntime
  regionExports: RegionExportController
  updates: UpdatePresenter
  revealInFolder(path: string): void
}

/** Renderer state selection and layout. Global resources belong to runtime. */
export default function App({
  runtime,
  regionExports,
  updates,
  revealInFolder
}: Props): JSX.Element {
  const loadState = useStore((state) => state.loadState)
  const hasVolume = useStore((state) => state.volume !== null)
  const hasMaximized = useStore((state) => state.maximizedView !== null)
  const folderOpen = useStore((state) => state.folder !== null)
  const folderLoading = useStore((state) => state.folderLoading)
  const filePanelOpen = useStore((state) => state.filePanelOpen)
  const sidebarOpen = useStore((state) => state.sidePanelOpen)
  const shortcutsOpen = useStore((state) => state.shortcutsOpen)
  const setShortcutsOpen = useStore((state) => state.setShortcutsOpen)
  const { dragging, dropTarget } = useSyncExternalStore(
    runtime.subscribeUi,
    runtime.getUiSnapshot,
    runtime.getUiSnapshot
  )

  return (
    <div className="app">
      {(loadState === 'loading' || folderLoading) && <div className="loading-bar" />}
      <main
        className={`workspace${folderOpen && filePanelOpen ? ' has-files' : ''}${sidebarOpen ? '' : ' sidebar-closed'}${hasMaximized ? ' has-max' : ''}`}
      >
        {folderOpen && filePanelOpen && (
          <FilePanel onSelect={(entry) => runtime.requestEntry(entry.path)} />
        )}
        {hasVolume ? (
          <>
            <SliceView view={0} />
            <SliceView view={1} />
            <SliceView view={2} />
            <VolumeView />
            <SidePanel onAddOverlay={runtime.addOverlayDialog} regionExports={regionExports} />
          </>
        ) : (
          <EmptyState onOpen={runtime.openFileDialog} onOpenFolder={runtime.openFolderDialog} />
        )}
      </main>
      <StatusBar />
      <NotificationCenter updates={updates} revealInFolder={revealInFolder} />
      {shortcutsOpen && (
        <ShortcutsOverlay
          isMac={runtime.platform === 'darwin'}
          onClose={() => setShortcutsOpen(false)}
        />
      )}
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
