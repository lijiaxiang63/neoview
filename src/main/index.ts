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
import { join } from 'path'
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
import type { ViewMenuState } from '../shared/files'
import { FileAccessAuthorizer } from './files/access'
import { createFileDialogs } from './files/dialogs'
import { createExportService } from './files/exports'
import { registerFileIpc } from './files/ipc'
import { createFileReader } from './files/reader'
import { createFolderScanner } from './files/scanner'
import { OpenJobCoordinator, type OpenJobScope } from './openJobs'
import { sendIfAlive, windowContentsIfAlive } from './windowLifecycle'
import { createApplicationWindow } from './applicationWindow'
import { OpenIntentIssuer } from '../shared/openIntents'
import { shouldCreateWindowOnActivate, shouldQuitAfterAllWindowsClosed } from './appLifecycle'
import { createApplicationMenuTemplate } from './menu'
import { installLaunchFileRouting } from './launchFiles'
import {
  createRendererMainFrameGate,
  isolatedRendererResponse,
  RENDERER_SCHEME,
  rendererRequestPath,
  rendererServerUrl
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

let lastDialogDirectory: string | undefined

function dialogDirectoryPath(): string {
  return join(app.getPath('userData'), 'dialog-directory.json')
}

async function loadDialogDirectory(): Promise<void> {
  const raw = await fs.readFile(dialogDirectoryPath(), 'utf8').catch(() => '')
  try {
    const parsed: unknown = JSON.parse(raw)
    lastDialogDirectory = typeof parsed === 'string' && parsed.length > 0 ? parsed : undefined
  } catch {
    lastDialogDirectory = undefined
  }
}

let dialogDirectorySaveTail: Promise<void> = Promise.resolve()

function saveDialogDirectory(directory: string): Promise<void> {
  lastDialogDirectory = directory
  dialogDirectorySaveTail = dialogDirectorySaveTail
    .then(() => fs.writeFile(dialogDirectoryPath(), JSON.stringify(directory)))
    .catch(() => {
      // A picker choice remains valid even if its convenience history cannot be saved.
    })
  return dialogDirectorySaveTail
}

const fileDialogs = createFileDialogs(
  {
    showOpenDialog: (window, options) => dialog.showOpenDialog(window, options),
    getLastUsedDirectory: () => lastDialogDirectory,
    saveLastUsedDirectory: saveDialogDirectory
  },
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
let lastViewState: ViewMenuState = {
  fileList: true,
  sidePanel: true,
  folderOpen: false,
  directionLabels: true,
  crosshair: true
}

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
  const sendToWindow = (channel: string): void => {
    const window = getWindow()
    if (window) sendIfAlive(window, channel)
  }
  app.setAboutPanelOptions({
    applicationName: app.name,
    applicationVersion: app.getVersion(),
    credits: 'Made with ♥ by jiaxiang',
    authors: ['jiaxiang'],
    website: HOMEPAGE_URL,
    iconPath: icon
  })
  const openRecent = async (path: string): Promise<void> => {
    const window = getWindow()
    if (!window) return
    const scope = captureWindowOpenScope(window)
    if (!scope) return
    const intent = openIntents.issue()
    const result = await deliverBaseOpen(window, intent, scope, (signal) =>
      fileReader.read(path, path, signal)
    )
    if (result !== 'error') return
    recentFiles = removeRecent(recentFiles, path)
    saveRecentFiles()
    buildMenu(getWindow)
  }
  const labels = recentLabels(recentFiles)
  const template = createApplicationMenuTemplate({
    isMac: process.platform === 'darwin',
    appName: app.name,
    viewState: lastViewState,
    recentItems: recentFiles.map((path, index) => ({ path, label: labels[index] })),
    autoCheckEnabled: updateService?.autoCheckEnabled() ?? true,
    actions: {
      openFile: () => {
        void (async () => {
          const window = getWindow()
          if (!window) return
          const scope = captureWindowOpenScope(window)
          if (!scope) return
          const intent = openIntents.issue()
          let path: string | null
          try {
            path = await fileDialogs.pickFilePath(window)
          } catch (error) {
            deliverBaseOpenError(window, intent, scope, error)
            return
          }
          if (path === null || !openJobs.scopeIsCurrent(scope)) return
          await deliverBaseOpen(window, intent, scope, (signal) =>
            fileReader.read(path, path, signal)
          )
        })()
      },
      openFolder: () => sendToWindow('open-folder-request'),
      openRecent: (path) => void openRecent(path),
      clearRecent: () => {
        recentFiles = []
        saveRecentFiles()
        app.clearRecentDocuments()
        buildMenu(getWindow)
      },
      openBuiltinBase: () => {
        const window = getWindow()
        if (window) {
          void sendBuiltinFile(
            window,
            builtinVolume,
            'builtin-volume.nii.gz',
            'file-opened',
            openIntents.issue()
          )
        }
      },
      openBuiltinOverlay: () => {
        const window = getWindow()
        if (window) {
          void sendBuiltinFile(window, builtinOverlay, 'builtin-overlay.nii.gz', 'overlay-opened')
        }
      },
      showShortcuts: () => sendToWindow('show-shortcuts'),
      undo: () => sendToWindow('menu-undo'),
      redo: () => sendToWindow('menu-redo'),
      toggleFilePanel: () => sendToWindow('toggle-file-panel'),
      toggleSidePanel: () => sendToWindow('toggle-side-panel'),
      toggleDirectionLabels: () => sendToWindow('toggle-direction-labels'),
      toggleCrosshair: () => sendToWindow('toggle-crosshair'),
      openHomepage: () => void shell.openExternal(HOMEPAGE_URL),
      openRepository: () => void shell.openExternal(REPO_URL),
      checkForUpdates: () => void updateService?.checkForUpdates(true),
      setAutoCheck: (enabled) => updateService?.setAutoCheck(enabled)
    }
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// macOS can't switch the installed icon by appearance, but the running app's
// Dock icon can follow the system theme. Read the OS preference directly.
function macSystemDark(): boolean {
  return systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') === 'Dark'
}

function syncDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  app.dock.setIcon(macSystemDark() ? icon : iconLight)
}

function createWindow(): BrowserWindow {
  return createApplicationWindow({
    icon,
    developmentRendererUrl,
    isTrustedMainFrame: rendererMainFrameIsTrusted,
    invalidateOpenOwner: (contents) => openJobs.invalidateOwner(contents),
    logIncident,
    crashLogPath,
    closeCancelled: () => updateService?.closeCancelled()
  })
}

const gotLock = installLaunchFileRouting({
  getWindow: applicationWindow,
  issueIntent: () => openIntents.issue(),
  captureWindow: (window, requireLoaded) => captureWindowOpenScope(window, requireLoaded),
  captureContents: (contents) => openJobs.capture(contents),
  open: async (window, path, intent, scope) => {
    await deliverBaseOpen(window, intent, scope, (signal) => fileReader.read(path, path, signal))
  },
  isExcludedContents: (contentsId) => storageMigrationWindowIds.has(contentsId)
})

if (gotLock) {
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
      await Promise.all([loadRecentFiles(), loadDialogDirectory()])

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
      const onViewState = (event: Electron.IpcMainEvent, state: ViewMenuState): void => {
        if (!rendererMainFrameIsTrusted(event) || !state || typeof state !== 'object') return
        lastViewState = {
          fileList: Boolean(state.fileList),
          sidePanel: Boolean(state.sidePanel),
          folderOpen: Boolean(state.folderOpen),
          directionLabels: Boolean(state.directionLabels),
          crosshair: Boolean(state.crosshair)
        }
        const menu = Menu.getApplicationMenu()
        const fileList = menu?.getMenuItemById('view-file-list')
        if (fileList) {
          fileList.enabled = Boolean(state.folderOpen)
          fileList.checked = Boolean(state.folderOpen && state.fileList)
        }
        const sidePanel = menu?.getMenuItemById('view-side-panel')
        if (sidePanel) sidePanel.checked = Boolean(state.sidePanel)
        const directionLabels = menu?.getMenuItemById('view-direction-labels')
        if (directionLabels) directionLabels.checked = Boolean(state.directionLabels)
        const crosshair = menu?.getMenuItemById('view-crosshair')
        if (crosshair) crosshair.checked = Boolean(state.crosshair)
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
