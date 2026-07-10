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
import { join, resolve } from 'path'
import { promises as fs } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoCheckEnabled, checkForUpdates, initUpdater, setAutoCheck } from './update'
import {
  addRecent,
  parseRecentPayload,
  recentLabels,
  removeRecent,
  serializeRecentPayload
} from './recentFiles'
import type { FilePanelState } from '../shared/files'
import { FileAccessAuthorizer } from './files/access'
import { createFileDialogs } from './files/dialogs'
import { createExportService } from './files/exports'
import { registerFileIpc } from './files/ipc'
import { isVolumeFileName } from './files/names'
import { createFileReader } from './files/reader'
import { createFolderScanner } from './files/scanner'
import icon from '../../resources/icon.png?asset'
import iconLight from '../../resources/icon-light.png?asset'
// Sample data shipped with the app so a fresh install has something to show
// without hunting for a file: one base volume and one labels overlay.
import builtinVolume from '../../resources/builtin-volume.nii.gz?asset'
import builtinOverlay from '../../resources/builtin-overlay.nii.gz?asset'

// The renderer styles both a dark and a light theme (prefers-color-scheme),
// so the native chrome (title bar, menus, dialogs) follows the OS setting.
nativeTheme.themeSource = 'system'

// Crash forensics: a dead renderer or GPU process otherwise leaves only a
// blank, unresponsive window with no trace of why. Every incident is
// appended to crash.log in userData so a report can name the reason
// (e.g. 'oom' vs 'crashed' vs a GPU process death).
const crashLogPath = (): string => join(app.getPath('userData'), 'crash.log')

function logIncident(kind: string, details: unknown): void {
  const payload = { details, systemMemory: process.getSystemMemoryInfo() }
  const line = `${new Date().toISOString()} ${kind} ${JSON.stringify(payload)}\n`
  console.error(line.trim())
  fs.appendFile(crashLogPath(), line).catch(() => {
    // Logging must never throw.
  })
}

// GPU / utility process deaths are app-level, not per-window.
app.on('child-process-gone', (_e, details) => {
  logIncident('child-process-gone', details)
})

const fileReader = createFileReader({ stat: fs.stat, readFile: fs.readFile })
const folderScanner = createFolderScanner({
  readdir: (path) => fs.readdir(path, { withFileTypes: true })
})
const exportService = createExportService({
  stat: fs.stat,
  access: fs.access,
  writeBytes: (path, bytes) => fs.writeFile(path, bytes),
  writeText: (path, text) => fs.writeFile(path, text, 'utf8')
})
const fileAccess = new FileAccessAuthorizer({ realpath: fs.realpath })
const fileDialogs = createFileDialogs(
  { showOpenDialog: (window, options) => dialog.showOpenDialog(window, options) },
  fileReader
)

const HOMEPAGE_URL = 'https://lijiaxiang63.github.io/neoview/'
const REPO_URL = 'https://github.com/lijiaxiang63/neoview'

// ---------------------------------------------------------------------------
// Recent files (File > Open Recent). The list persists in userData and is
// fed by the renderer reporting every base volume it commits with a path.

let recentFiles: string[] = []

function recentFilesPath(): string {
  return join(app.getPath('userData'), 'recent-files.json')
}

async function loadRecentFiles(): Promise<void> {
  recentFiles = parseRecentPayload(await fs.readFile(recentFilesPath(), 'utf8').catch(() => ''))
}

// Saves chain on this tail so a slow earlier write can never finish after
// (and clobber) a newer one; each link persists the list as of its call.
let recentSaveTail: Promise<void> = Promise.resolve()

function saveRecentFiles(): void {
  const payload = serializeRecentPayload(recentFiles)
  recentSaveTail = recentSaveTail
    .then(() => fs.writeFile(recentFilesPath(), payload))
    .catch(() => {
      // Losing the recents list is not worth surfacing (and a failed write
      // must not break the chain for the ones behind it).
    })
}

// The View menu's checkbox state survives menu rebuilds (recents changing)
// by re-applying the last state the renderer reported.
let lastViewState = { fileList: true, sidePanel: true, folderOpen: false }

/** Load a bundled sample into the window over `channel` ('file-opened' for the
 * base volume, 'overlay-opened' for a layer), reporting failures the same way
 * a picked file would. */
async function sendBuiltinFile(
  win: BrowserWindow,
  assetPath: string,
  name: string,
  channel: 'file-opened' | 'overlay-opened'
): Promise<void> {
  try {
    // Bundled assets deliberately carry an empty path so exports ask for a folder.
    win.webContents.send(channel, await fileReader.readNamed(assetPath, name))
  } catch (err) {
    win.webContents.send('file-open-error', (err as Error).message)
  }
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
  const shortcutsItem: Electron.MenuItemConstructorOptions = {
    label: 'Keyboard Shortcuts',
    click: () => getWindow()?.webContents.send('show-shortcuts')
  }

  // A recent entry that fails to read (moved/deleted file) reports the error
  // the same way a picked file would, and drops out of the list.
  const openRecent = async (path: string): Promise<void> => {
    const win = getWindow()
    if (!win) return
    try {
      win.webContents.send('file-opened', await fileReader.read(path))
    } catch (err) {
      win.webContents.send('file-open-error', (err as Error).message)
      recentFiles = removeRecent(recentFiles, path)
      saveRecentFiles()
      buildMenu(getWindow)
    }
  }
  const labels = recentLabels(recentFiles)
  const recentItems: Electron.MenuItemConstructorOptions[] =
    recentFiles.length === 0
      ? [{ label: 'No Recent Files', enabled: false }]
      : [
          ...recentFiles.map((p, i) => ({
            label: labels[i],
            click: () => void openRecent(p)
          })),
          { type: 'separator' as const },
          {
            label: 'Clear Menu',
            click: () => {
              recentFiles = []
              saveRecentFiles()
              app.clearRecentDocuments()
              buildMenu(getWindow)
            }
          }
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
              const opened = await fileDialogs.pickAndRead(win)
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
        { label: 'Open Recent', submenu: recentItems },
        { type: 'separator' },
        {
          label: 'Open Built-in Volume',
          click: () => {
            const win = getWindow()
            if (win)
              void sendBuiltinFile(win, builtinVolume, 'builtin-volume.nii.gz', 'file-opened')
          }
        },
        {
          // Routes to an overlay layer; the renderer shows a hint if no base
          // volume is loaded yet.
          label: 'Open Built-in Overlay',
          click: () => {
            const win = getWindow()
            if (win)
              void sendBuiltinFile(win, builtinOverlay, 'builtin-overlay.nii.gz', 'overlay-opened')
          }
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    // Edit/Window only on macOS (clipboard shortcuts in text fields need the
    // menu roles there); on Windows/Linux they would just widen the menu bar.
    // Undo/Redo are custom: their accelerators must reach the renderer, which
    // routes them to region-edit history (or a text field's own undo).
    ...(isMac
      ? [
          {
            label: 'Edit',
            submenu: [
              {
                label: 'Undo',
                accelerator: 'CmdOrCtrl+Z',
                click: () => getWindow()?.webContents.send('menu-undo')
              },
              {
                label: 'Redo',
                accelerator: 'Shift+CmdOrCtrl+Z',
                click: () => getWindow()?.webContents.send('menu-redo')
              },
              { type: 'separator' as const },
              { role: 'cut' as const },
              { role: 'copy' as const },
              { role: 'paste' as const },
              { role: 'selectAll' as const }
            ]
          }
        ]
      : []),
    {
      label: 'View',
      submenu: [
        {
          id: 'view-file-list',
          label: 'File List',
          type: 'checkbox',
          checked: lastViewState.folderOpen && lastViewState.fileList,
          enabled: lastViewState.folderOpen,
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => getWindow()?.webContents.send('toggle-file-panel')
        },
        {
          id: 'view-side-panel',
          label: 'Side Panel',
          type: 'checkbox',
          checked: lastViewState.sidePanel,
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
      ? {
          role: 'help' as const,
          submenu: [shortcutsItem, { type: 'separator' as const }, ...linkItems]
        }
      : {
          label: 'Help',
          submenu: [
            shortcutsItem,
            { type: 'separator' as const },
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
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d10' : '#e7e9ee',
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

  // A gone renderer paints the window solid white with no other symptom;
  // record why (reason 'oom' vs 'crashed', exit code) and tell the user
  // where the log landed. 'unresponsive' separates hangs from crashes.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logIncident('render-process-gone', details)
    dialog.showErrorBox(
      'Display process stopped',
      `Reason: ${details.reason} (exit code ${details.exitCode})\n` +
        `Details were appended to:\n${crashLogPath()}`
    )
  })
  mainWindow.on('unresponsive', () => logIncident('window-unresponsive', {}))
  mainWindow.on('responsive', () => logIncident('window-responsive-again', {}))

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
  // macOS delivers system recent-documents (and Finder) opens here. A path
  // arriving before the renderer is listening is held and flushed after the
  // page loads.
  let pendingOpenPath: string | null = null
  const openPathInto = async (win: BrowserWindow, path: string): Promise<void> => {
    try {
      win.webContents.send('file-opened', await fileReader.read(path))
    } catch (err) {
      win.webContents.send('file-open-error', (err as Error).message)
    }
  }
  app.on('open-file', (e, path) => {
    e.preventDefault()
    if (!isVolumeFileName(path)) return
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.webContents.isLoading()) void openPathInto(win, path)
    else pendingOpenPath = path
  })
  /** Windows and Linux deliver document opens (recent-documents list, file
   * association) as a plain path argument instead of an open-file event:
   * the last argv entry naming a volume file, resolved against `cwd`. */
  const volumePathFromArgv = (args: readonly string[], cwd: string): string | null => {
    for (let i = args.length - 1; i >= 0; i--) {
      const a = args[i]
      if (!a.startsWith('-') && isVolumeFileName(a)) return resolve(cwd, a)
    }
    return null
  }
  // A cold start may carry the document path in argv (argv[0] is the binary).
  pendingOpenPath = volumePathFromArgv(process.argv.slice(1), process.cwd())
  app.on('browser-window-created', (_e, win) => {
    win.webContents.on('did-finish-load', () => {
      if (!pendingOpenPath) return
      const path = pendingOpenPath
      pendingOpenPath = null
      // A short delay lets the renderer register its listeners first.
      setTimeout(() => void openPathInto(win, path), 250)
    })
  })

  app.on('second-instance', (_e, argv, workingDirectory) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    // The second launch may have been an OS document open; route its path
    // exactly like an open-file event.
    const path = volumePathFromArgv(argv.slice(1), workingDirectory)
    if (!path) return
    if (win && !win.webContents.isLoading()) void openPathInto(win, path)
    else pendingOpenPath = path
  })

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.neoview.app')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // Load persisted recents before any renderer can report a newly opened
    // path, so an in-flight read can never overwrite a later addition.
    await loadRecentFiles()

    const disposeFileIpc = registerFileIpc({
      ipc: ipcMain,
      access: fileAccess,
      dialogs: fileDialogs,
      reader: fileReader,
      scanner: folderScanner,
      exporter: exportService,
      windowFromSender: (sender) => BrowserWindow.fromWebContents(sender),
      isDirectory: async (path) => (await fs.stat(path).catch(() => null))?.isDirectory() ?? false,
      revealInFolder: (path) => shell.showItemInFolder(path),
      noteFileOpened: (path) => {
        recentFiles = addRecent(recentFiles, path)
        app.addRecentDocument(path)
        saveRecentFiles()
        buildMenu(() => BrowserWindow.getAllWindows()[0] ?? null)
      }
    })
    app.once('will-quit', disposeFileIpc)

    // The renderer owns panel visibility; it mirrors every change here so the
    // View menu's checkboxes track it (including toggles it makes itself).
    ipcMain.on('view-state', (_event, state: FilePanelState) => {
      lastViewState = {
        fileList: Boolean(state.fileList),
        sidePanel: Boolean(state.sidePanel),
        folderOpen: Boolean(state.folderOpen)
      }
      const menu = Menu.getApplicationMenu()
      const fileList = menu?.getMenuItemById('view-file-list')
      if (fileList) {
        fileList.enabled = Boolean(state.folderOpen)
        fileList.checked = Boolean(state.folderOpen && state.fileList)
      }
      const sidePanel = menu?.getMenuItemById('view-side-panel')
      if (sidePanel) sidePanel.checked = Boolean(state.sidePanel)
    })

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
