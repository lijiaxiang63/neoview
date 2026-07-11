import type { FilePanelState } from '../../../shared/files'
import type { AppState } from '../store'

/** 'auto' follows the loaded-state snapshot captured when a drop happens. */
export type LoadTarget = 'base' | 'overlay' | 'auto'

export type AppKeyCommand =
  | 'cancel-region'
  | 'restore-view'
  | 'commit-region'
  | 'shrink-brush'
  | 'grow-brush'
  | 'show-shortcuts'
  | 'undo'
  | 'redo'
  | 'previous-file'
  | 'next-file'

export type MenuHistoryTarget = 'blocked' | 'text' | 'regions'

export interface KeyEventSnapshot {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  defaultPrevented?: boolean
  target?: unknown
}

export interface KeyStateSnapshot {
  hasRegionBox: boolean
  maximizedView: boolean
  folderOpen: boolean
  shortcutsOpen: boolean
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number'])

function property(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined
}

function tagNameOf(value: unknown): string | null {
  const tagName = property(value, 'tagName')
  return typeof tagName === 'string' ? tagName.toUpperCase() : null
}

/** Text buffers own undo/redo; non-text form controls do not. */
export function isTextEntry(value: unknown): boolean {
  const tagName = tagNameOf(value)
  if (tagName === 'TEXTAREA') return true
  if (tagName === 'INPUT') {
    const type = property(value, 'type')
    return typeof type === 'string' && TEXT_INPUT_TYPES.has(type.toLowerCase())
  }
  return property(value, 'isContentEditable') === true
}

/** Remove Electron's invoke wrapper while preserving useful read errors. */
export function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'Could not open file.'
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Keep the drop filter aligned with the native open dialog. */
export function acceptsVolumeFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.nii') || lower.endsWith('.nii.gz')
}

/** Resolve the nearest split drop zone without depending on DOM globals. */
export function dropTargetAt(target: unknown): LoadTarget {
  const closest = property(target, 'closest')
  if (typeof closest !== 'function') return 'auto'
  const zone = closest.call(target, '[data-drop-target]') as unknown
  const dataset = property(zone, 'dataset')
  const value = property(dataset, 'dropTarget')
  return value === 'base' || value === 'overlay' ? value : 'auto'
}

/** Decide which application command, if any, owns a keydown. */
export function keyCommand(event: KeyEventSnapshot, state: KeyStateSnapshot): AppKeyCommand | null {
  if (event.defaultPrevented || state.shortcutsOpen || isTextEntry(event.target)) return null

  const undoCombo =
    (event.metaKey === true || event.ctrlKey === true) &&
    event.altKey !== true &&
    event.key.toLowerCase() === 'z'
  const tagName = tagNameOf(event.target)
  if ((tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA') && !undoCombo) {
    return null
  }

  if (event.key === 'Escape' && state.hasRegionBox) return 'cancel-region'
  if (event.key === 'Escape' && state.maximizedView) return 'restore-view'
  if (event.key === 'Enter' && state.hasRegionBox) return 'commit-region'
  if (event.key === '[') return 'shrink-brush'
  if (event.key === ']') return 'grow-brush'
  if (event.key === '?') return 'show-shortcuts'
  if (undoCombo) return event.shiftKey ? 'redo' : 'undo'
  if (event.key === 'ArrowUp' && state.folderOpen) return 'previous-file'
  if (event.key === 'ArrowDown' && state.folderOpen) return 'next-file'
  return null
}

export function menuHistoryTarget(
  shortcutsOpen: boolean,
  activeElement: unknown
): MenuHistoryTarget {
  if (shortcutsOpen) return 'blocked'
  return isTextEntry(activeElement) ? 'text' : 'regions'
}

export function viewMenuSnapshot(
  state: Pick<AppState, 'filePanelOpen' | 'sidePanelOpen' | 'folder'>
): FilePanelState {
  return {
    fileList: state.filePanelOpen,
    sidePanel: state.sidePanelOpen,
    folderOpen: state.folder !== null
  }
}

export function sameViewMenuSnapshot(a: FilePanelState | null, b: FilePanelState): boolean {
  return (
    a !== null &&
    a.fileList === b.fileList &&
    a.sidePanel === b.sidePanel &&
    a.folderOpen === b.folderOpen
  )
}

/** Return the next playback frame only while the interval still owns the
 * current lightweight volume session. A stale tick is inert without retaining
 * the prior Volume and its raw buffer. */
export function playbackFrameTarget(
  state: Pick<AppState, 'volume' | 'volumeSession' | 'frame'>,
  ownerSession: number
): number | null {
  const volume = state.volume
  if (!volume || state.volumeSession !== ownerSession || volume.frames <= 1) return null
  return (state.frame + 1) % volume.frames
}

export const UNSAVED_WARNING =
  'There are region edits that have not been exported. They will be lost. Continue?'
export const UNCOMMITTED_WARNING =
  'There is a drawn region that has not been committed. It will be lost. Continue?'

export function discardWarning(state: Pick<AppState, 'segDirty' | 'segBox'>): string | null {
  if (state.segDirty) return UNSAVED_WARNING
  if (state.segBox) return UNCOMMITTED_WARNING
  return null
}
