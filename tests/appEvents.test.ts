import { describe, expect, it } from 'vitest'
import {
  acceptsVolumeFileName,
  discardWarning,
  dropTargetAt,
  ipcErrorMessage,
  isTextEntry,
  keyCommand,
  menuHistoryTarget,
  playbackFrameTarget,
  sameViewMenuSnapshot,
  UNCOMMITTED_WARNING,
  UNSAVED_WARNING,
  viewMenuSnapshot
} from '../src/renderer/src/runtime/appEvents'

const target = (tagName: string, extra: Record<string, unknown> = {}): unknown => ({
  tagName,
  ...extra
})

describe('application event decisions', () => {
  it('identifies text buffers without treating every input as text', () => {
    expect(isTextEntry(target('textarea'))).toBe(true)
    expect(isTextEntry(target('input', { type: 'number' }))).toBe(true)
    expect(isTextEntry(target('input', { type: 'range' }))).toBe(false)
    expect(isTextEntry(target('div', { isContentEditable: true }))).toBe(true)
    expect(isTextEntry(null)).toBe(false)
  })

  it('cleans invoke wrappers and keeps plain errors intact', () => {
    expect(
      ipcErrorMessage(new Error("Error invoking remote method 'read-file': Error: Access denied"))
    ).toBe('Access denied')
    expect(ipcErrorMessage(new Error('Bad bytes'))).toBe('Bad bytes')
    expect(ipcErrorMessage('unknown')).toBe('Could not open file.')
  })

  it('accepts the native dialog extensions case-insensitively', () => {
    expect(acceptsVolumeFileName('a.nii')).toBe(true)
    expect(acceptsVolumeFileName('a.NII.GZ')).toBe(true)
    expect(acceptsVolumeFileName('a.zip')).toBe(false)
  })

  it('resolves the nearest split drop zone and falls back to auto', () => {
    expect(dropTargetAt({ closest: () => ({ dataset: { dropTarget: 'base' } }) })).toBe('base')
    expect(dropTargetAt({ closest: () => ({ dataset: { dropTarget: 'overlay' } }) })).toBe(
      'overlay'
    )
    expect(dropTargetAt({ closest: () => ({ dataset: { dropTarget: 'other' } }) })).toBe('auto')
    expect(dropTargetAt(null)).toBe('auto')
  })

  it('maps keys with region, view, folder, and undo priority', () => {
    const idle = {
      hasRegionBox: false,
      maximizedView: false,
      folderOpen: false,
      shortcutsOpen: false
    }
    expect(
      keyCommand({ key: 'Escape' }, { ...idle, hasRegionBox: true, maximizedView: true })
    ).toBe('cancel-region')
    expect(keyCommand({ key: 'Escape' }, { ...idle, maximizedView: true })).toBe('restore-view')
    expect(keyCommand({ key: 'Enter' }, { ...idle, hasRegionBox: true })).toBe('commit-region')
    expect(keyCommand({ key: '[', target: target('input', { type: 'range' }) }, idle)).toBe(null)
    expect(
      keyCommand({ key: 'z', ctrlKey: true, target: target('input', { type: 'range' }) }, idle)
    ).toBe('undo')
    expect(keyCommand({ key: 'z', metaKey: true, shiftKey: true }, idle)).toBe('redo')
    expect(keyCommand({ key: 'ArrowDown' }, { ...idle, folderOpen: true })).toBe('next-file')
    expect(keyCommand({ key: 'ArrowUp' }, { ...idle, folderOpen: true })).toBe('previous-file')
  })

  it('blocks background commands while typing, after prevention, or behind shortcuts', () => {
    const ready = {
      hasRegionBox: true,
      maximizedView: true,
      folderOpen: true,
      shortcutsOpen: false
    }
    expect(keyCommand({ key: 'Enter', target: target('input', { type: 'text' }) }, ready)).toBe(
      null
    )
    expect(keyCommand({ key: 'Enter', defaultPrevented: true }, ready)).toBe(null)
    expect(keyCommand({ key: 'Enter' }, { ...ready, shortcutsOpen: true })).toBe(null)
    expect(menuHistoryTarget(true, null)).toBe('blocked')
    expect(menuHistoryTarget(false, target('textarea'))).toBe('text')
    expect(menuHistoryTarget(false, target('button'))).toBe('regions')
  })

  it('makes a stale playback tick inert after the volume is replaced', () => {
    const owner = { frames: 3 } as never
    const replacement = { frames: 4 } as never
    expect(playbackFrameTarget({ volume: owner, volumeSession: 4, frame: 1 }, 4)).toBe(2)
    expect(playbackFrameTarget({ volume: owner, volumeSession: 4, frame: 2 }, 4)).toBe(0)
    expect(playbackFrameTarget({ volume: replacement, volumeSession: 5, frame: 0 }, 4)).toBeNull()
  })

  it('creates comparable View menu snapshots', () => {
    const first = viewMenuSnapshot({
      filePanelOpen: true,
      sidePanelOpen: false,
      folder: null,
      directionLabelsVisible: true,
      crosshairVisible: false
    })
    expect(first).toEqual({
      fileList: true,
      sidePanel: false,
      folderOpen: false,
      directionLabels: true,
      crosshair: false
    })
    expect(sameViewMenuSnapshot(first, { ...first })).toBe(true)
    expect(sameViewMenuSnapshot(first, { ...first, folderOpen: true })).toBe(false)
    expect(sameViewMenuSnapshot(first, { ...first, directionLabels: false })).toBe(false)
    expect(sameViewMenuSnapshot(first, { ...first, crosshair: true })).toBe(false)
    expect(sameViewMenuSnapshot(null, first)).toBe(false)
  })

  it('prioritizes unsaved work over an uncommitted box', () => {
    expect(discardWarning({ segDirty: true, segBox: {} as never })).toBe(UNSAVED_WARNING)
    expect(discardWarning({ segDirty: false, segBox: {} as never })).toBe(UNCOMMITTED_WARNING)
    expect(discardWarning({ segDirty: false, segBox: null })).toBe(null)
  })
})
