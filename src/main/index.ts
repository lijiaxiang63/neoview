import {
  app,
  shell,
  dialog,
  BrowserWindow,
  Menu,
  ipcMain,
  net,
  nativeTheme,
  protocol,
  systemPreferences
} from 'electron'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { promises as fs } from 'fs'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createUpdateService, type UpdateService } from './update'
import { AsyncQuitCoordinator, finalizeApplicationExit } from './updateService'
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
import { OpenJobCoordinator, type OpenJobScope } from './openJobs'
import {
  CloseResponderLeaseState,
  needsCloseConfirmation,
  sendIfAlive,
  windowContentsIfAlive,
  WindowCloseCoordinator,
  type CloseResolution
} from './windowLifecycle'
import { OpenIntentIssuer } from '../shared/openIntents'
import { shouldCreateWindowOnActivate, shouldQuitAfterAllWindowsClosed } from './appLifecycle'
import {
  createRendererMainFrameGate,
  externalWebUrl,
  isolatedRendererResponse,
  RENDERER_ORIGIN,
  RENDERER_SCHEME,
  rendererRequestPath,
  rendererServerUrl,
  rendererUrlIsTrusted
} from './rendererProtocol'
import {
  PERSISTED_STORAGE_KEYS,
  parsePersistedStorageSnapshot,
  STORAGE_MIGRATION_QUERY,
  type PersistedStorageSnapshot
} from '../shared/storageMigration'
import icon from '../../resources/icon.png?asset'
import iconLight from '../../resources/icon-light.png?asset'
// Sample data shipped with the app so a fresh install has something to show
// without hunting for a file: one base volume and one labels overlay.
import builtinVolume from '../../resources/builtin-volume.nii.gz?asset'
import builtinOverlay from '../../resources/builtin-overlay.nii.gz?asset'

// A secure standard origin lets production use the same cross-origin
// isolation contract as the development server. Registration must happen
// before Electron becomes ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true
    }
  }
])

const developmentRendererUrl = rendererServerUrl(process.env['ELECTRON_RENDERER_URL'])
const rendererMainFrameIsTrusted = createRendererMainFrameGate(developmentRendererUrl)
const storageMigrationWindowIds = new Set<number>()
let initialWindowPending = false

function applicationWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((window) => {
    const contents = windowContentsIfAlive(window)
    if (!contents) return false
    try {
      return !storageMigrationWindowIds.has(contents.id)
    } catch {
      return false
    }
  })
}

function applicationWindow(): BrowserWindow | null {
  return applicationWindows()[0] ?? null
}

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

const fileReader = createFileReader({
  stat: fs.stat,
  readFile: (path, signal) => fs.readFile(path, { signal })
})
const folderScanner = createFolderScanner({
  readdir: (path) => fs.readdir(path, { withFileTypes: true })
})
const exportService = createExportService({
  stat: fs.stat,
  openExclusive: async (path) => {
    const file = await fs.open(path, 'wx')
    return {
      write: (contents) =>
        typeof contents === 'string'
          ? file.writeFile(contents, { encoding: 'utf8' })
          : file.writeFile(contents),
      close: () => file.close()
    }
  },
  remove: (path) => fs.rm(path, { force: true })
})
const fileAccess = new FileAccessAuthorizer({ realpath: fs.realpath })
const fileDialogs = createFileDialogs(
  { showOpenDialog: (window, options) => dialog.showOpenDialog(window, options) },
  fileReader
)
const openIntents = new OpenIntentIssuer()
const openJobs = new OpenJobCoordinator<Electron.WebContents>()
let nextOverlayOpenId = 0
let updateService: UpdateService | null = null

function captureWindowOpenScope(
  win: BrowserWindow | null,
  requireLoaded = false
): OpenJobScope<Electron.WebContents> | null {
  if (!win) return null
  const contents = windowContentsIfAlive(win)
  if (!contents) return null
  try {
    if (requireLoaded && contents.isLoading()) return null
  } catch {
    return null
  }
  return openJobs.capture(contents)
}

const HOMEPAGE_URL = 'https://lijiaxiang63.github.io/neoview/'
const REPO_URL = 'https://github.com/lijiaxiang63/neoview'

function installRendererProtocol(): () => void {
  const root = join(__dirname, '../renderer')
  protocol.handle(RENDERER_SCHEME, async (request) => {
    const path = rendererRequestPath(root, request.url)
    if (!path) return new Response(null, { status: 404 })
    try {
      return isolatedRendererResponse(await net.fetch(pathToFileURL(path).toString()))
    } catch {
      return new Response(null, { status: 404 })
    }
  })
  return () => protocol.unhandle(RENDERER_SCHEME)
}

function storageMigrationMarkerPath(): string {
  return join(app.getPath('userData'), 'storage-origin-v1')
}

async function formerOriginStorage(): Promise<PersistedStorageSnapshot | null> {
  if (!app.isPackaged) return null
  const alreadyApplied = await fs
    .stat(storageMigrationMarkerPath())
    .then(() => true)
    .catch(() => false)
  if (alreadyApplied) return null

  const migrationWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  const migrationWindowId = migrationWindow.webContents.id
  storageMigrationWindowIds.add(migrationWindowId)
  initialWindowPending = true
  try {
    await migrationWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { [STORAGE_MIGRATION_QUERY]: '1' }
    })
    const keys = JSON.stringify(PERSISTED_STORAGE_KEYS)
    const value: unknown = await migrationWindow.webContents.executeJavaScript(
      `Object.fromEntries(${keys}.flatMap((key) => { const value = localStorage.getItem(key); return value === null ? [] : [[key, value]] }))`
    )
    return parsePersistedStorageSnapshot(value)
  } catch {
    // Leave both markers absent so a transient read failure retries next run.
    return null
  } finally {
    if (!migrationWindow.isDestroyed()) migrationWindow.destroy()
    storageMigrationWindowIds.delete(migrationWindowId)
  }
}

function installStorageMigrationIpc(initial: PersistedStorageSnapshot | null): () => void {
  let snapshot = initial
  let markerWrite: Promise<void> | null = null
  const isRendererMainFrame = (event: Electron.IpcMainEvent): boolean =>
    rendererMainFrameIsTrusted(event)
  const onRead = (event: Electron.IpcMainEvent): void => {
    event.returnValue = isRendererMainFrame(event) ? snapshot : null
  }
  const onApplied = (event: Electron.IpcMainEvent): void => {
    if (!isRendererMainFrame(event) || snapshot === null || markerWrite) return
    const acknowledged = snapshot
    markerWrite = fs
      .writeFile(storageMigrationMarkerPath(), '1')
      .then(() => {
        if (snapshot === acknowledged) snapshot = null
      })
      .catch(() => {
        // Keep the snapshot so a later acknowledgement can retry this phase.
      })
      .finally(() => {
        markerWrite = null
      })
  }
  ipcMain.on('storage-migration-read', onRead)
  ipcMain.on('storage-migration-applied', onApplied)
  return () => {
    ipcMain.removeListener('storage-migration-read', onRead)
    ipcMain.removeListener('storage-migration-applied', onApplied)
  }
}

type BaseOpenOutcome = 'sent' | 'stale' | 'error'

async function deliverBaseOpen(
  win: BrowserWindow,
  intent: number,
  scope: OpenJobScope<Electron.WebContents>,
  read: (signal: AbortSignal) => Promise<Awaited<ReturnType<typeof fileReader.read>>>
): Promise<BaseOpenOutcome> {
  const job = openJobs.begin(intent, scope)
  if (!job) return 'stale'
  try {
    const opened = await read(job.signal)
    if (!openJobs.isCurrent(job)) return 'stale'
    return sendIfAlive(win, 'file-opened', intent, opened) ? 'sent' : 'stale'
  } catch (error) {
    if (!openJobs.isCurrent(job)) return 'stale'
    if (!openJobs.accept(intent)) return 'stale'
    sendIfAlive(win, 'file-open-error', (error as Error).message, intent)
    return 'error'
  } finally {
    openJobs.finish(job)
  }
}

function deliverBaseOpenError(
  win: BrowserWindow,
  intent: number,
  scope: OpenJobScope<Electron.WebContents>,
  error: unknown
): void {
  if (!openJobs.scopeIsCurrent(scope) || !openJobs.accept(intent)) return
  sendIfAlive(win, 'file-open-error', (error as Error).message, intent)
}

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
  channel: 'file-opened' | 'overlay-opened',
  intent?: number
): Promise<void> {
  const baseIntent = channel === 'file-opened' ? (intent ?? openIntents.issue()) : undefined
  if (baseIntent !== undefined) {
    const scope = captureWindowOpenScope(win)
    if (!scope) return
    await deliverBaseOpen(win, baseIntent, scope, (signal) =>
      fileReader.readNamed(assetPath, name, '', signal)
    )
    return
  }
  const overlayOpenId = ++nextOverlayOpenId
  if (!sendIfAlive(win, 'overlay-open-started', overlayOpenId)) return
  let opened: Awaited<ReturnType<typeof fileReader.readNamed>>
  try {
    // Bundled assets deliberately carry an empty path so exports ask for a folder.
    opened = await fileReader.readNamed(assetPath, name)
  } catch (err) {
    sendIfAlive(win, 'overlay-open-error', overlayOpenId, (err as Error).message)
    return
  }
  sendIfAlive(win, channel, overlayOpenId, opened)
}

function buildMenu(getWindow: () => BrowserWindow | null): void {
  const isMac = process.platform === 'darwin'
  const sendToWindow = (channel: string): void => {
    const win = getWindow()
    if (win) sendIfAlive(win, channel)
  }
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
    click: () => sendToWindow('show-shortcuts')
  }

  // A recent entry that fails to read (moved/deleted file) reports the error
  // the same way a picked file would, and drops out of the list.
  const openRecent = async (path: string): Promise<void> => {
    const win = getWindow()
    if (!win) return
    const scope = captureWindowOpenScope(win)
    if (!scope) return
    const intent = openIntents.issue()
    const result = await deliverBaseOpen(win, intent, scope, (signal) =>
      fileReader.read(path, path, signal)
    )
    if (result === 'error') {
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
      click: () => void updateService?.checkForUpdates(true)
    },
    {
      label: 'Check for Updates Automatically',
      type: 'checkbox',
      checked: updateService?.autoCheckEnabled() ?? true,
      click: (item) => updateService?.setAutoCheck(item.checked)
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
            const scope = captureWindowOpenScope(win)
            if (!scope) return
            const intent = openIntents.issue()
            let path: string | null
            try {
              path = await fileDialogs.pickFilePath(win)
            } catch (err) {
              deliverBaseOpenError(win, intent, scope, err)
              return
            }
            if (path === null || !openJobs.scopeIsCurrent(scope)) return
            await deliverBaseOpen(win, intent, scope, (signal) =>
              fileReader.read(path, path, signal)
            )
          }
        },
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+Shift+O',
          // The renderer owns the whole flow (picker, scan, loading feedback),
          // so the menu only asks it to start.
          click: () => sendToWindow('open-folder-request')
        },
        { label: 'Open Recent', submenu: recentItems },
        { type: 'separator' },
        {
          label: 'Open Built-in Volume',
          click: () => {
            const win = getWindow()
            if (win)
              void sendBuiltinFile(
                win,
                builtinVolume,
                'builtin-volume.nii.gz',
                'file-opened',
                openIntents.issue()
              )
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
                click: () => sendToWindow('menu-undo')
              },
              {
                label: 'Redo',
                accelerator: 'Shift+CmdOrCtrl+Z',
                click: () => sendToWindow('menu-redo')
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
          click: () => sendToWindow('toggle-file-panel')
        },
        {
          id: 'view-side-panel',
          label: 'Side Panel',
          type: 'checkbox',
          checked: lastViewState.sidePanel,
          accelerator: 'CmdOrCtrl+B',
          click: () => sendToWindow('toggle-side-panel')
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
  // BrowserWindow.webContents throws once the native window is destroyed.
  // Capture its identity while alive so the `closed` cleanup can use it only
  // as an ownership key without touching the destroyed BrowserWindow wrapper.
  const mainContents = mainWindow.webContents

  const closeResponder = new CloseResponderLeaseState()
  const closeCoordinator = new WindowCloseCoordinator()

  const finishClose = (resolution: CloseResolution | null): void => {
    if (resolution === 'quit-app') app.quit()
    else if (resolution === 'close-window') mainWindow.close()
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // A gone renderer paints the window solid white with no other symptom;
  // record why (reason 'oom' vs 'crashed', exit code) and tell the user
  // where the log landed. 'unresponsive' separates hangs from crashes.
  mainContents.on('render-process-gone', (_e, details) => {
    openJobs.invalidateOwner(mainContents)
    closeResponder.rendererLost()
    logIncident('render-process-gone', details)
    dialog.showErrorBox(
      'Display process stopped',
      `Reason: ${details.reason} (exit code ${details.exitCode})\n` +
        `Details were appended to:\n${crashLogPath()}`
    )
    finishClose(closeCoordinator.rendererLost())
  })
  mainContents.on('did-navigate', () => {
    // A provisional, blocked or failed navigation can leave the original
    // document alive. Ownership changes only after a new document commits.
    openJobs.invalidateOwner(mainContents)
    closeResponder.navigationCommitted()
    if (closeCoordinator.isAwaiting()) finishClose(closeCoordinator.rendererLost())
  })
  const preventUntrustedNavigation = (event: Electron.Event, url: string): void => {
    if (rendererUrlIsTrusted(url, developmentRendererUrl)) return
    event.preventDefault()
    const external = externalWebUrl(url)
    if (external) void shell.openExternal(external)
  }
  mainContents.on('will-navigate', (event) => {
    preventUntrustedNavigation(event, event.url)
  })
  mainContents.on('will-redirect', (event) => {
    preventUntrustedNavigation(event, event.url)
  })
  mainWindow.on('unresponsive', () => logIncident('window-unresponsive', {}))
  mainWindow.on('responsive', () => logIncident('window-responsive-again', {}))

  // Closing goes through the renderer first so unsaved region edits can veto
  // it (the renderer replies on 'close-confirmed' once the user agrees).
  // Whether the intercepted close came from an app quit, so confirming it
  // resumes the quit instead of just closing the window.
  const onBeforeQuit = (): void => {
    quitRequested = true
  }
  let quitRequested = false
  app.on('before-quit', onBeforeQuit)
  mainWindow.on('close', (e) => {
    if (
      !needsCloseConfirmation(
        closeCoordinator.isAllowed(),
        closeResponder.isReady(),
        mainContents.isDestroyed()
      )
    ) {
      return
    }
    const request = closeCoordinator.request(quitRequested)
    quitRequested = false
    if (request.kind === 'allow') return
    e.preventDefault()
    if (request.kind === 'waiting') return
    const responderLease = closeResponder.activeLeaseId()
    if (
      responderLease === null ||
      !sendIfAlive(mainWindow, 'close-requested', request.requestId, responderLease)
    ) {
      closeResponder.rendererLost()
      finishClose(closeCoordinator.rendererLost())
      return
    }
  })
  const isCurrentMainFrame = (
    event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent
  ): boolean => event.sender === mainContents && rendererMainFrameIsTrusted(event)
  const ownsCloseResponder = (event: Electron.IpcMainEvent, lease: unknown): boolean =>
    isCurrentMainFrame(event) && closeResponder.owns(lease)
  const onCloseConfirmed = (
    event: Electron.IpcMainEvent,
    requestId: unknown,
    lease: unknown
  ): void => {
    if (ownsCloseResponder(event, lease)) {
      const resolution = closeCoordinator.confirm(requestId)
      finishClose(resolution)
    }
  }
  const onCloseCancelled = (
    event: Electron.IpcMainEvent,
    requestId: unknown,
    lease: unknown
  ): void => {
    if (!ownsCloseResponder(event, lease)) return
    if (closeCoordinator.cancel(requestId)) {
      updateService?.closeCancelled()
    }
  }
  const onCloseResponderClaim = (event: Electron.IpcMainInvokeEvent): number => {
    if (!isCurrentMainFrame(event)) throw new Error('Close responder is unavailable.')
    return closeResponder.claim()
  }
  const onCloseResponderActivate = (event: Electron.IpcMainEvent, lease: unknown): void => {
    if (!isCurrentMainFrame(event) || !closeResponder.activate(lease)) return
    const requestId = closeCoordinator.pendingRequestId()
    const responderLease = closeResponder.activeLeaseId()
    if (
      requestId !== null &&
      (responderLease === null ||
        !sendIfAlive(mainWindow, 'close-requested', requestId, responderLease))
    ) {
      closeResponder.rendererLost()
      finishClose(closeCoordinator.rendererLost())
    }
  }
  const onCloseResponderRelease = (event: Electron.IpcMainEvent, lease: unknown): void => {
    if (!isCurrentMainFrame(event)) return
    if (closeResponder.release(lease) && closeCoordinator.isAwaiting()) {
      finishClose(closeCoordinator.rendererLost())
    }
  }
  ipcMain.handle('close-responder-claim', onCloseResponderClaim)
  ipcMain.on('close-responder-activate', onCloseResponderActivate)
  ipcMain.on('close-confirmed', onCloseConfirmed)
  ipcMain.on('close-cancelled', onCloseCancelled)
  ipcMain.on('close-responder-release', onCloseResponderRelease)
  mainWindow.on('closed', () => {
    openJobs.invalidateOwner(mainContents)
    ipcMain.removeHandler('close-responder-claim')
    ipcMain.removeListener('close-responder-activate', onCloseResponderActivate)
    ipcMain.removeListener('close-confirmed', onCloseConfirmed)
    ipcMain.removeListener('close-cancelled', onCloseCancelled)
    ipcMain.removeListener('close-responder-release', onCloseResponderRelease)
    app.removeListener('before-quit', onBeforeQuit)
  })

  mainContents.setWindowOpenHandler((details) => {
    const external = externalWebUrl(details.url)
    if (external) void shell.openExternal(external)
    return { action: 'deny' }
  })

  if (developmentRendererUrl) {
    mainWindow.loadURL(developmentRendererUrl)
  } else {
    mainWindow.loadURL(`${RENDERER_ORIGIN}/index.html`)
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
  let pendingOpen: { path: string; intent: number } | null = null
  const openPathInto = async (
    win: BrowserWindow,
    path: string,
    intent: number,
    scope: OpenJobScope<Electron.WebContents>
  ): Promise<void> => {
    await deliverBaseOpen(win, intent, scope, (signal) => fileReader.read(path, path, signal))
  }
  app.on('open-file', (e, path) => {
    e.preventDefault()
    if (!isVolumeFileName(path)) return
    const intent = openIntents.issue()
    const win = applicationWindow()
    const scope = captureWindowOpenScope(win, true)
    if (win && scope) void openPathInto(win, path, intent, scope)
    else pendingOpen = { path, intent }
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
  const startupPath = volumePathFromArgv(process.argv.slice(1), process.cwd())
  pendingOpen = startupPath ? { path: startupPath, intent: openIntents.issue() } : null
  app.on('browser-window-created', (_e, win) => {
    const contents = windowContentsIfAlive(win)
    if (!contents) return
    const contentsId = contents.id
    contents.on('did-finish-load', () => {
      if (storageMigrationWindowIds.has(contentsId)) return
      if (!pendingOpen) return
      const { path, intent } = pendingOpen
      pendingOpen = null
      const scope = openJobs.capture(contents)
      // A short delay lets the renderer register its listeners first.
      setTimeout(() => void openPathInto(win, path, intent, scope), 250)
    })
  })

  app.on('second-instance', (_e, argv, workingDirectory) => {
    const win = applicationWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    // The second launch may have been an OS document open; route its path
    // exactly like an open-file event.
    const path = volumePathFromArgv(argv.slice(1), workingDirectory)
    if (!path) return
    const intent = openIntents.issue()
    const scope = captureWindowOpenScope(win, true)
    if (win && scope) void openPathInto(win, path, intent, scope)
    else pendingOpen = { path, intent }
  })

  void app
    .whenReady()
    .then(async () => {
      electronApp.setAppUserModelId('com.neoview.app')

      if (!developmentRendererUrl) {
        const disposeRendererProtocol = installRendererProtocol()
        app.once('will-quit', disposeRendererProtocol)
      }

      app.on('browser-window-created', (_, window) => {
        optimizer.watchWindowShortcuts(window)
      })

      const migrationSnapshot = await formerOriginStorage()
      const disposeStorageMigrationIpc = installStorageMigrationIpc(migrationSnapshot)
      app.once('will-quit', disposeStorageMigrationIpc)

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
        openJobs,
        isTrustedMainFrame: rendererMainFrameIsTrusted,
        windowFromSender: (sender) => BrowserWindow.fromWebContents(sender),
        isDirectory: async (path) =>
          (await fs.stat(path).catch(() => null))?.isDirectory() ?? false,
        revealInFolder: (path) => shell.showItemInFolder(path),
        noteFileOpened: (path) => {
          recentFiles = addRecent(recentFiles, path)
          app.addRecentDocument(path)
          saveRecentFiles()
          buildMenu(applicationWindow)
        }
      })
      app.once('will-quit', disposeFileIpc)

      ipcMain.handle('begin-base-intent', (event) => {
        if (!rendererMainFrameIsTrusted(event)) {
          throw new Error('Base-open intent is unavailable.')
        }
        return openIntents.issue()
      })
      const onBaseIntentAccepted = (event: Electron.IpcMainEvent, intent: unknown): void => {
        if (rendererMainFrameIsTrusted(event)) openJobs.accept(intent)
      }
      ipcMain.on('accept-base-intent', onBaseIntentAccepted)

      // The renderer owns panel visibility; it mirrors every change here so the
      // View menu's checkboxes track it (including toggles it makes itself).
      const onViewState = (event: Electron.IpcMainEvent, state: FilePanelState): void => {
        if (!rendererMainFrameIsTrusted(event) || !state || typeof state !== 'object') return
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
      }
      ipcMain.on('view-state', onViewState)
      app.once('will-quit', () => {
        ipcMain.removeHandler('begin-base-intent')
        ipcMain.removeListener('accept-base-intent', onBaseIntentAccepted)
        ipcMain.removeListener('view-state', onViewState)
      })

      createWindow()
      initialWindowPending = false
      updateService = createUpdateService(applicationWindow, rendererMainFrameIsTrusted)
      const updateQuit = new AsyncQuitCoordinator()
      app.on('will-quit', (event) => {
        const service = updateService
        if (!service) return
        // Electron does not await will-quit listeners. Hold the process open
        // until serialized settings and owned temporary resources settle, then
        // explicitly finalize installer hand-off and exit without quit re-entry.
        updateQuit.intercept(
          event,
          () => service.dispose(),
          () => {
            updateService = null
            // `will-quit` has already run after every window passed its close
            // gate. Do not depend on a second app.quit() re-entering Electron's
            // macOS termination sequence once no windows remain.
            finalizeApplicationExit(service.finalizeQuit, () => app.exit(0))
          }
        )
      })
      buildMenu(applicationWindow)

      syncDockIcon()
      // nativeTheme 'updated' won't fire for OS theme changes while themeSource
      // is pinned, so listen to the system notification instead.
      if (process.platform === 'darwin') {
        systemPreferences.subscribeNotification('AppleInterfaceThemeChangedNotification', () =>
          syncDockIcon()
        )
      }

      app.on('activate', function () {
        if (
          shouldCreateWindowOnActivate(
            applicationWindows().length,
            updateQuit.allowsWindowCreation()
          )
        ) {
          createWindow()
        }
      })
    })
    .catch((error) => {
      initialWindowPending = false
      logIncident('startup-failed', error)
      app.quit()
    })
}

app.on('window-all-closed', () => {
  if (
    shouldQuitAfterAllWindowsClosed(
      process.platform,
      initialWindowPending,
      applicationWindows().length
    )
  ) {
    app.quit()
  }
})
