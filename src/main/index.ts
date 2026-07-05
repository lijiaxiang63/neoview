import { app, shell, dialog, BrowserWindow, Menu, ipcMain } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

const MAX_FILE_BYTES = 2 * 1024 ** 3

interface OpenedFile {
  name: string
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
  return { name, bytes }
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
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
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
    { role: 'windowMenu' }
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

    createWindow()
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
