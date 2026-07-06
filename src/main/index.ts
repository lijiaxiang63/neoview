import {
  app,
  shell,
  dialog,
  BrowserWindow,
  Menu,
  ipcMain,
  nativeTheme,
  systemPreferences
} from 'electron'
import { join, resolve, sep } from 'path'
import { promises as fs } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoCheckEnabled, checkForUpdates, initUpdater, setAutoCheck } from './update'
import icon from '../../resources/icon.png?asset'
import iconLight from '../../resources/icon-light.png?asset'

// The app UI is dark-only; forcing the native theme makes all window chrome
// (title bar, menu bar, popup menus, dialogs) render dark to match, instead
// of following the OS setting.
nativeTheme.themeSource = 'dark'

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

const HOMEPAGE_URL = 'https://lijiaxiang63.github.io/neoview/'
const REPO_URL = 'https://github.com/lijiaxiang63/neoview'

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
  // Feeds the 'about' role on every platform (macOS ignores iconPath and
  // uses the app icon; Windows/Linux show the Electron-drawn panel).
  app.setAboutPanelOptions({
    applicationName: app.name,
    applicationVersion: app.getVersion(),
    credits: 'Made with ♥ by jiaxiang',
    authors: ['jiaxiang'],
    website: HOMEPAGE_URL,
    iconPath: icon
  })
  const linkItems: Electron.MenuItemConstructorOptions[] = [
    { label: 'Website', click: () => void shell.openExternal(HOMEPAGE_URL) },
    { label: 'GitHub Repository', click: () => void shell.openExternal(REPO_URL) }
  ]
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
    // Edit/Window only on macOS (clipboard shortcuts in text fields need the
    // menu roles there); on Windows/Linux they would just widen the menu bar.
    ...(isMac ? [{ role: 'editMenu' as const }] : []),
    {
      label: 'View',
      submenu: [
        {
          id: 'view-file-list',
          label: 'File List',
          type: 'checkbox',
          checked: false,
          enabled: false,
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => getWindow()?.webContents.send('toggle-file-panel')
        },
        {
          id: 'view-side-panel',
          label: 'Side Panel',
          type: 'checkbox',
          checked: true,
          accelerator: 'CmdOrCtrl+B',
          click: () => getWindow()?.webContents.send('toggle-side-panel')
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    },
    ...(isMac ? [{ role: 'windowMenu' as const }] : []),
    // macOS keeps updates/About in the app menu, so Help only carries links;
    // the 'help' role also gives it the system search field.
    isMac
      ? { role: 'help' as const, submenu: linkItems }
      : {
          label: 'Help',
          submenu: [
            ...linkItems,
            { type: 'separator' as const },
            ...updateItems,
            { type: 'separator' as const },
            { role: 'about' as const }
          ]
        }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// macOS can't switch the installed (Finder/Launchpad) icon by appearance, but
// the running app's Dock icon can follow the system theme: the light artwork in
// Light Mode, the dark artwork (same as the shipped .icns) in Dark Mode.
// nativeTheme is forced to 'dark' app-wide, so the OS setting has to be read
// directly (shouldUseDarkColors would always report dark).
function macSystemDark(): boolean {
  return systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') === 'Dark'
}

function syncDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  app.dock.setIcon(macSystemDark() ? icon : iconLight)
}

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0d10',
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

    // Scans stream found files to the requesting window while they run, so
    // the list fills (and the first file can load) before the scan finishes.
    // The scanned root is registered before scanning starts — 'read-file'
    // serves streamed paths immediately — and stored as a real path so the
    // symlink-resolved containment check below lines up.
    // The caller's token rides along in every progress batch (opaque here),
    // so the renderer can discard batches from a scan it has superseded.
    const scanAndStream = async (
      sender: Electron.WebContents,
      path: string,
      token: number
    ): Promise<FolderScan> => {
      scannedRoots.add(await fs.realpath(path))
      return scanFolder(path, (batch) => {
        if (!sender.isDestroyed()) {
          sender.send('scan-folder-progress', { token, root: path, files: batch })
        }
      })
    }

    const asToken = (t: unknown): number => (typeof t === 'number' ? t : 0)

    // Directory picker + scan in one main-owned flow: the renderer never
    // supplies the path, so it cannot register arbitrary roots this way.
    ipcMain.handle('open-folder-scan', async (event, token: number) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return null
      const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      if (result.canceled || result.filePaths.length === 0) return null
      return scanAndStream(event.sender, result.filePaths[0], asToken(token))
    })

    // Read-only metadata probe (registers nothing): drops ask this before
    // starting a scan, so a plain-file drop never touches scan state.
    ipcMain.handle('is-directory', async (_event, path: string) => {
      if (typeof path !== 'string' || !path) return false
      const stat = await fs.stat(path).catch(() => null)
      return stat?.isDirectory() ?? false
    })

    // Drag&drop path; null when it is not a directory (the caller falls back
    // to single-file handling). The preload derives the path from the dropped
    // File object itself, so page script cannot funnel arbitrary strings here.
    ipcMain.handle('scan-folder', async (event, path: string, token: number) => {
      if (typeof path !== 'string' || !path) return null
      const stat = await fs.stat(path).catch(() => null)
      if (!stat?.isDirectory()) return null
      return scanAndStream(event.sender, path, asToken(token))
    })

    /** `p` is `root` or beneath it (roots may already end with the separator,
     * e.g. '/' or a drive root — appending another would break the test). */
    const isUnder = (root: string, p: string): boolean => {
      if (p === root) return true
      const prefix = root.endsWith(sep) ? root : root + sep
      return p.startsWith(prefix)
    }

    /** Validate a renderer-supplied path for reading: volume extension and
     * containment in a scanned root. Resolves symlinks before the containment
     * check, so `<root>/link/...` cannot escape the opened folder (the roots
     * are stored resolved too). The file is still read and reported under the
     * requested path: the renderer matches it against the folder list by that
     * identity. */
    const authorizeReadPath = async (path: unknown): Promise<string> => {
      if (typeof path !== 'string' || !isVolumeName(path)) {
        throw new Error('Not a .nii or .nii.gz file.')
      }
      const full = resolve(path)
      const real = await fs.realpath(full).catch(() => null)
      const inRoot = real !== null && [...scannedRoots].some((root) => isUnder(root, real))
      if (!inRoot) throw new Error('File is outside the opened folder.')
      return full
    }

    ipcMain.handle('read-file', async (_event, path: string) => {
      return readVolumeFile(await authorizeReadPath(path))
    })

    // Size-gated read for opportunistic prefetching: the size check runs on
    // the stat, BEFORE any bytes are read or transferred, so warming a large
    // neighbor can never allocate a huge buffer behind the user's back.
    ipcMain.handle('read-file-limited', async (_event, path: string, maxBytes: number) => {
      const full = await authorizeReadPath(path)
      const limit =
        typeof maxBytes === 'number' && Number.isFinite(maxBytes)
          ? Math.min(Math.max(maxBytes, 0), MAX_FILE_BYTES)
          : 0
      const stat = await fs.stat(full)
      if (stat.size > limit) return null
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

    // The renderer owns panel visibility; it mirrors every change here so the
    // View menu's checkboxes track it (including toggles it makes itself).
    ipcMain.on(
      'view-state',
      (_event, state: { fileList: boolean; sidePanel: boolean; folderOpen: boolean }) => {
        const menu = Menu.getApplicationMenu()
        const fileList = menu?.getMenuItemById('view-file-list')
        if (fileList) {
          fileList.enabled = Boolean(state.folderOpen)
          fileList.checked = Boolean(state.folderOpen && state.fileList)
        }
        const sidePanel = menu?.getMenuItemById('view-side-panel')
        if (sidePanel) sidePanel.checked = Boolean(state.sidePanel)
      }
    )

    createWindow()
    initUpdater(() => BrowserWindow.getAllWindows()[0] ?? null)
    buildMenu(() => BrowserWindow.getAllWindows()[0] ?? null)

    syncDockIcon()
    // nativeTheme 'updated' won't fire for OS theme changes while themeSource
    // is pinned, so listen to the system notification instead.
    if (process.platform === 'darwin') {
      systemPreferences.subscribeNotification('AppleInterfaceThemeChangedNotification', () =>
        syncDockIcon()
      )
    }

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
