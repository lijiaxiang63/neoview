import { useEffect, useMemo, useRef, type JSX } from 'react'
import { useStore } from '../store'
import {
  groupEntries,
  regionExportView,
  splitDisplayName,
  type FolderEntry
} from '../files/folderList'

interface Props {
  onSelect: (entry: FolderEntry) => void
}

function DoneBadge(): JSX.Element {
  return (
    <span className="done-badge" role="img" aria-label="Regions exported" title="Regions exported">
      <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">
        <path
          d="M1.5 4.8 3.6 7 7.5 2.2"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

function FileGlyph(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2.5 1.5h4L9.5 4.5v6a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5 0Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path d="M6.5 1.5v3h3" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  )
}

export function FilePanel({ onSelect }: Props): JSX.Element | null {
  const folder = useStore((s) => s.folder)
  const folderLoading = useStore((s) => s.folderLoading)
  const sourcePath = useStore((s) => s.sourcePath)
  const pendingPath = useStore((s) => s.pendingFilePath)
  const toggleFilePanel = useStore((s) => s.toggleFilePanel)
  const exportedPaths = useStore((s) => s.exportedPaths)
  const activeRef = useRef<HTMLButtonElement | null>(null)

  // Referentially stable per files array (regionExportView caches), so the
  // useMemo below keys off it directly.
  const view = folder ? regionExportView(folder.files) : null
  const groups = useMemo(() => (view ? groupEntries(view.files) : []), [view])

  // While scrubbing with the arrow keys the pending target leads; once the
  // load settles the loaded row takes over.
  const focusPath = pendingPath ?? sourcePath

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [focusPath])

  if (!folder || !view) return null

  return (
    <aside className="file-panel">
      <header className="file-panel-head">
        <h3>Files</h3>
        <span className="count mono">{view.files.length}</span>
        <button
          className="file-panel-close"
          title="Hide file list (folder stays open)"
          onClick={toggleFilePanel}
        >
          «
        </button>
      </header>
      <div className="file-panel-root mono" title={folder.root}>
        {folder.root}
      </div>
      <div className="file-list" role="listbox" aria-label="Volume files">
        {groups.map((g) => (
          <div className="file-group" key={g.relDir || '.'}>
            {g.relDir !== '' && (
              <div className="file-group-head" title={g.relDir}>
                {g.relDir}
              </div>
            )}
            {g.entries.map((f) => {
              const active = f.path === sourcePath
              const pending = pendingPath !== null && f.path === pendingPath && !active
              const done = view.exportedFor.has(f.path) || exportedPaths.has(f.path)
              const { stem, ext } = splitDisplayName(f.name)
              return (
                <button
                  key={f.path}
                  role="option"
                  aria-selected={active}
                  ref={f.path === focusPath ? activeRef : undefined}
                  className={`file-row${active ? ' active' : ''}${pending ? ' pending' : ''}`}
                  title={f.name}
                  // Drop focus after a click: arrow keys are keyboard input,
                  // so a still-focused row would grow a focus ring later.
                  onClick={(e) => {
                    e.currentTarget.blur()
                    onSelect(f)
                  }}
                >
                  <FileGlyph />
                  <span className="file-name">{stem}</span>
                  <span className="ext-badge">{ext}</span>
                  {done && <DoneBadge />}
                </button>
              )
            })}
          </div>
        ))}
        {folder.files.length === 0 && !folderLoading && (
          <div className="file-empty">No .nii or .nii.gz files found</div>
        )}
        {folderLoading && <div className="file-empty">Scanning…</div>}
        {folder.truncated && (
          <div className="file-empty">Showing the first {folder.files.length} files</div>
        )}
      </div>
    </aside>
  )
}
