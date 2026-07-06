import { app, shell, dialog, BrowserWindow, Menu, ipcMain } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoCheckEnabled, checkForUpdates, initUpdater, setAutoCheck } from './update'
import icon from '../../resources/icon.png?asset'

const MAX_FILE_BYTES = 2 * 1024 ** 3

interface OpenedFile {
  name: string
  path: string
  bytes: ArrayBuffer
}

async function readVolumeFile(path: string): Promise<OpenedFile> {
  const stat = await fs.stat(path)
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error('File is larger than 2 GB, which is not supported.')
  }
  const buf = await fs.readFile(path)
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const name = path.split(/[\\/]/).pop() ?? path
  return { name, path, bytes }
}

interface ExportRequest {
  /** Target directory; must already exist. */
  dir: string
  fileName: string
  bytes: ArrayBuffer
  /** Optional companion text file written next to the main one. */
  sidecar: { fileName: string; text: string } | null
}

interface ExportResult {
  path: string
  sidecarPath: string | null
}

function splitExportName(fileName: string): { stem: string; ext: string } {
  const m = /\.(nii\.gz|nii|gz|txt)$/i.exec(fileName)
  if (!m) return { stem: fileName, ext: '' }
  return { stem: fileName.slice(0, m.index), ext: m[0] }
}

/** First "<stem><suffix><ext>" that does not exist yet: '', '-1', '-2', … */
async function uniquePath(dir: string, fileName: string): Promise<string> {
  const { stem, ext } = splitExportName(fileName)
  for (let n = 0; ; n++) {
    const candidate = join(dir, n === 0 ? `${stem}${ext}` : `${stem}-${n}${ext}`)
    try {
      await fs.access(candidate)
    } catch {
      return candidate
    }
  }
}

async function writeExport(req: ExportRequest): Promise<ExportResult> {
  const dir = req.dir
  if (!(await fs.stat(dir).catch(() => null))?.isDirectory()) {
    throw new Error(`Export folder does not exist: ${dir}`)
  }
  // Reject anything path-like so the renderer cannot escape the chosen folder.
  if (/[\\/]/.test(req.fileName) || (req.sidecar && /[\\/]/.test(req.sidecar.fileName))) {
    throw new Error('Invalid export file name.')
  }
  const path = await uniquePath(dir, req.fileName)
  await fs.writeFile(path, Buffer.from(req.bytes))
  let sidecarPath: string | null = null
  if (req.sidecar) {
    // Keep the sidecar's name in step with any collision suffix on the main file.
    const chosenStem = splitExportName(path.split(/[\\/]/).pop() ?? '').stem
    const sidecarExt = splitExportName(req.sidecar.fileName).ext || '.txt'
    sidecarPath = await uniquePath(dir, `${chosenStem}${sidecarExt}`)
    await fs.writeFile(sidecarPath, req.sidecar.text, 'utf8')
  }
  return { path, sidecarPath }
}

async function pickAndReadFile(win: BrowserWindow): Promise<OpenedFile | null> {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Volume files', extensions: ['nii', 'nii.gz', 'gz'] },
      { name: 'All files', extensions: ['*'] }
    ]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return readVolumeFile(result.filePaths[0])
}

function buildMenu(getWindow: () => BrowserWindow | null): void {
  const isMac = process.platform === 'darwin'
  const updateItems: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Check for Updates…',
      click: () => {
        const win = getWindow()
        if (win) void checkForUpdates(win, true)
      }
    },
    {
      label: 'Check for Updates Automatically',
      type: 'checkbox',
      checked: autoCheckEnabled(),
      click: (item) => setAutoCheck(item.checked)
    }
  ]
  // The default appMenu role has no room for custom items, so spell it out
  // to slot the update entries in the conventional place.
  const macAppMenu: Electron.MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      ...updateItems,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [macAppMenu] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const win = getWindow()
            if (!win) return
            try {
              const opened = await pickAndReadFile(win)
              if (opened) win.webContents.send('file-opened', opened)
            } catch (err) {
              win.webContents.send('file-open-error', (err as Error).message)
            }
          }
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    ...(isMac ? [] : [{ label: 'Help', submenu: updateItems }])
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0d10',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : { autoHideMenuBar: false }),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Closing goes through the renderer first so unsaved region edits can veto
  // it (the renderer replies on 'close-confirmed' once the user agrees).
  let allowClose = false
  // Whether the intercepted close came from an app quit, so confirming it
  // resumes the quit instead of just closing the window.
  let pendingQuit = false
  const onBeforeQuit = (): void => {
    quitRequested = true
  }
  let quitRequested = false
  app.on('before-quit', onBeforeQuit)
  mainWindow.on('close', (e) => {
    if (allowClose || mainWindow.webContents.isDestroyed()) return
    pendingQuit = quitRequested
    quitRequested = false
    e.preventDefault()
    mainWindow.webContents.send('close-requested')
  })
  const onCloseConfirmed = (event: Electron.IpcMainEvent): void => {
    if (event.sender === mainWindow.webContents) {
      allowClose = true
      if (pendingQuit) app.quit()
      else mainWindow.close()
    }
  }
  ipcMain.on('close-confirmed', onCloseConfirmed)
  mainWindow.on('closed', () => {
    ipcMain.removeListener('close-confirmed', onCloseConfirmed)
    app.removeListener('before-quit', onBeforeQuit)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return mainWindow
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.neoview.app')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    ipcMain.handle('open-dialog', async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return null
      return pickAndReadFile(win)
    })

    ipcMain.handle('export-file', async (_event, req: ExportRequest) => writeExport(req))

    ipcMain.handle('pick-directory', async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return null
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory']
      })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    })

    ipcMain.on('reveal-in-folder', (_event, path: string) => {
      if (typeof path === 'string' && path) shell.showItemInFolder(path)
    })

    createWindow()
    initUpdater(() => BrowserWindow.getAllWindows()[0] ?? null)
    buildMenu(() => BrowserWindow.getAllWindows()[0] ?? null)

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
