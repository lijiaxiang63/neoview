import { app, shell, dialog, BrowserWindow, Menu, ipcMain } from 'electron'
import { join, resolve, sep } from 'path'
import { promises as fs } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
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

interface FolderEntry {
  name: string
  path: string
  /** Directory relative to the scanned root, '/'-joined; '' for the root itself. */
  relDir: string
}

interface FolderScan {
  root: string
  files: FolderEntry[]
  truncated: boolean
}

const SCAN_DEPTH_MAX = 8
const SCAN_FILES_MAX = 2000
// Directory reads run through a small pool: on slow (external) disks the
// per-readdir latency dominates, and overlapping reads roughly halves the
// scan time; beyond ~8 concurrent reads the disk itself is the bottleneck.
const SCAN_CONCURRENCY = 16
const SCAN_BATCH_MS = 200

function isVolumeName(name: string): boolean {
  const n = name.toLowerCase()
  return n.endsWith('.nii') || n.endsWith('.nii.gz')
}

/** onBatch streams newly found files every SCAN_BATCH_MS (first find flushes
 * immediately), so the caller can show results while the scan runs. */
async function scanFolder(
  root: string,
  onBatch?: (files: FolderEntry[]) => void
): Promise<FolderScan> {
  const files: FolderEntry[] = []
  let sent = 0
  let lastFlush = 0
  const maybeFlush = (): void => {
    if (!onBatch || sent >= files.length || Date.now() - lastFlush < SCAN_BATCH_MS) return
    onBatch(files.slice(sent))
    sent = files.length
    lastFlush = Date.now()
  }
  let truncated = false
  const pending: Array<{ dir: string; relDir: string; depth: number }> = [
    { dir: root, relDir: '', depth: 0 }
  ]

  const processDir = async (item: {
    dir: string
    relDir: string
    depth: number
  }): Promise<void> => {
    // An unreadable subfolder should not kill the whole scan.
    const entries = await fs.readdir(item.dir, { withFileTypes: true }).catch(() => [])
    for (const ent of entries) {
      if (truncated) return
      if (ent.name.startsWith('.') || ent.isSymbolicLink()) continue
      if (ent.isDirectory()) {
        if (item.depth < SCAN_DEPTH_MAX) {
          pending.push({
            dir: join(item.dir, ent.name),
            relDir: item.relDir ? `${item.relDir}/${ent.name}` : ent.name,
            depth: item.depth + 1
          })
        }
      } else if (ent.isFile() && isVolumeName(ent.name)) {
        if (files.length >= SCAN_FILES_MAX) {
          truncated = true
          return
        }
        files.push({ name: ent.name, path: join(item.dir, ent.name), relDir: item.relDir })
        maybeFlush()
      }
    }
  }

  await new Promise<void>((resolveDone) => {
    let active = 0
    const pump = (): void => {
      if (truncated) pending.length = 0
      // Resolve only once in-flight reads drain, so the result stops mutating.
      if (pending.length === 0 && active === 0) {
        resolveDone()
        return
      }
      while (active < SCAN_CONCURRENCY && pending.length > 0) {
        const item = pending.shift()
        if (!item) break
        active++
        void processDir(item).finally(() => {
          active--
          pump()
        })
      }
    }
    pump()
  })
  return { root, files, truncated }
}

/** Roots the user has opened; 'read-file' only serves paths under one of them. */
const scannedRoots = new Set<string>()

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
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+Shift+O',
          // The renderer owns the whole flow (picker, scan, loading feedback),
          // so the menu only asks it to start.
          click: () => getWindow()?.webContents.send('open-folder-request')
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

    // Path from the directory picker or a drag&drop; null when it is not a
    // directory (the caller falls back to single-file handling).
    ipcMain.handle('scan-folder', async (event, path: string) => {
      if (typeof path !== 'string' || !path) return null
      const stat = await fs.stat(path).catch(() => null)
      if (!stat?.isDirectory()) return null
      // Registered before the scan: the renderer starts loading streamed
      // files while the scan is still running.
      // Store the real path: 'read-file' compares real paths so a symlink
      // inside the tree cannot smuggle reads out of the root.
      scannedRoots.add(await fs.realpath(path))
      return scanFolder(path, (batch) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('scan-folder-progress', { root: path, files: batch })
        }
      })
    })

    ipcMain.handle('read-file', async (_event, path: string) => {
      if (typeof path !== 'string' || !isVolumeName(path)) {
        throw new Error('Not a .nii or .nii.gz file.')
      }
      // Resolve symlinks before the containment check, so `<root>/link/...`
      // cannot escape the opened folder (the roots are stored resolved too).
      // The file is still read and reported under the requested path: the
      // renderer matches it against the folder list by that identity.
      const full = resolve(path)
      const real = await fs.realpath(full).catch(() => null)
      let inRoot = false
      if (real !== null) {
        for (const root of scannedRoots) {
          if (real === root || real.startsWith(root + sep)) {
            inRoot = true
            break
          }
        }
      }
      if (!inRoot) throw new Error('File is outside the opened folder.')
      return readVolumeFile(full)
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
