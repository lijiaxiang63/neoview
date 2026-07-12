import type { BrowserWindow, OpenDialogReturnValue } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { createFileDialogs } from '../src/main/files/dialogs'
import type { FileReader } from '../src/main/files/reader'

describe('file dialogs', () => {
  it('reuses the last selected directory across dialog flows', async () => {
    const showOpenDialog = vi
      .fn()
      .mockResolvedValueOnce({ canceled: false, filePaths: ['/first/item'] })
      .mockResolvedValueOnce({ canceled: false, filePaths: ['/second'] })
      .mockResolvedValueOnce({ canceled: false, filePaths: ['/third'] })
    const dialogs = createFileDialogs({ showOpenDialog }, {} as FileReader)
    const window = {} as BrowserWindow

    await dialogs.pickFilePath(window)
    await dialogs.pickScanRoot(window)
    await dialogs.pickExportDirectory(window)

    expect(showOpenDialog.mock.calls[0][1]).not.toHaveProperty('defaultPath')
    expect(showOpenDialog.mock.calls[1][1]).toMatchObject({ defaultPath: '/first' })
    expect(showOpenDialog.mock.calls[2][1]).toMatchObject({ defaultPath: '/second' })
  })

  it('does not replace the last selected directory after cancellation', async () => {
    const canceled: OpenDialogReturnValue = { canceled: true, filePaths: [] }
    const showOpenDialog = vi
      .fn()
      .mockResolvedValueOnce({ canceled: false, filePaths: ['/first'] })
      .mockResolvedValueOnce(canceled)
      .mockResolvedValueOnce(canceled)
    const dialogs = createFileDialogs({ showOpenDialog }, {} as FileReader)
    const window = {} as BrowserWindow

    await dialogs.pickScanRoot(window)
    await dialogs.pickFilePath(window)
    await dialogs.pickExportDirectory(window)

    expect(showOpenDialog.mock.calls[2][1]).toMatchObject({ defaultPath: '/first' })
  })

  it('restores and saves the selected directory across service instances', async () => {
    let persisted = '/previous'
    const saveLastUsedDirectory = vi.fn(async (directory: string) => {
      persisted = directory
    })
    const firstShowOpenDialog = vi
      .fn()
      .mockResolvedValue({ canceled: false, filePaths: ['/next/item'] })
    const first = createFileDialogs(
      {
        showOpenDialog: firstShowOpenDialog,
        getLastUsedDirectory: () => persisted,
        saveLastUsedDirectory
      },
      {} as FileReader
    )

    await first.pickFilePath({} as BrowserWindow)

    expect(firstShowOpenDialog.mock.calls[0][1]).toMatchObject({ defaultPath: '/previous' })
    expect(saveLastUsedDirectory).toHaveBeenCalledWith('/next')

    const secondShowOpenDialog = vi.fn().mockResolvedValue({ canceled: true, filePaths: [] })
    const second = createFileDialogs(
      {
        showOpenDialog: secondShowOpenDialog,
        getLastUsedDirectory: () => persisted,
        saveLastUsedDirectory
      },
      {} as FileReader
    )

    await second.pickScanRoot({} as BrowserWindow)

    expect(secondShowOpenDialog.mock.calls[0][1]).toMatchObject({ defaultPath: '/next' })
  })

  it('offers volume and text files in the layer picker', async () => {
    const showOpenDialog = vi.fn().mockResolvedValue({ canceled: true, filePaths: [] })
    const dialogs = createFileDialogs({ showOpenDialog }, {} as FileReader)

    await dialogs.pickLayerPath({} as BrowserWindow)

    expect(showOpenDialog.mock.calls[0][1]).toMatchObject({ properties: ['openFile'] })
    expect(showOpenDialog.mock.calls[0][1].filters?.[0]).toEqual({
      name: 'Layer files',
      extensions: ['nii', 'nii.gz', 'txt']
    })
  })

  it('prefers the current file directory for layer and table pickers', async () => {
    const showOpenDialog = vi.fn().mockResolvedValue({ canceled: true, filePaths: [] })
    const dialogs = createFileDialogs(
      { showOpenDialog, getLastUsedDirectory: () => '/previous' },
      {} as FileReader
    )

    await dialogs.pickLayerPath({} as BrowserWindow, '/current/base.nii')
    await dialogs.pickLayerTablePath({} as BrowserWindow, '/other/base.nii.gz')

    expect(showOpenDialog.mock.calls[0][1]).toMatchObject({ defaultPath: '/current' })
    expect(showOpenDialog.mock.calls[1][1]).toMatchObject({
      defaultPath: '/other',
      filters: [
        { name: 'Text files', extensions: ['txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
  })
})
