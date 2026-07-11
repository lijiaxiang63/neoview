import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { join } from 'path'
import {
  CloseResponderLeaseState,
  needsCloseConfirmation,
  sendIfAlive,
  WindowCloseCoordinator,
  type CloseResolution
} from './windowLifecycle'
import {
  externalWebUrl,
  RENDERER_ORIGIN,
  rendererUrlIsTrusted,
  type RendererMainFrameGate
} from './rendererProtocol'

export interface ApplicationWindowDependencies {
  icon: string
  developmentRendererUrl: string | null
  isTrustedMainFrame: RendererMainFrameGate
  invalidateOpenOwner(contents: WebContents): void
  logIncident(kind: string, details: unknown): void
  crashLogPath(): string
  closeCancelled(): void
}

/** Create one application window and own every listener/IPC resource scoped
 * to its main document. Pure close-state decisions remain in windowLifecycle. */
export function createApplicationWindow(deps: ApplicationWindowDependencies): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d10' : '#e7e9ee',
    ...(process.platform === 'linux' ? { icon: deps.icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  const contents = window.webContents
  const responder = new CloseResponderLeaseState()
  const close = new WindowCloseCoordinator()

  const finishClose = (resolution: CloseResolution | null): void => {
    if (resolution === 'quit-app') app.quit()
    else if (resolution === 'close-window') window.close()
  }

  window.on('ready-to-show', () => window.show())
  contents.on('render-process-gone', (_event, details) => {
    deps.invalidateOpenOwner(contents)
    responder.rendererLost()
    deps.logIncident('render-process-gone', details)
    dialog.showErrorBox(
      'Display process stopped',
      `Reason: ${details.reason} (exit code ${details.exitCode})\n` +
        `Details were appended to:\n${deps.crashLogPath()}`
    )
    finishClose(close.rendererLost())
  })
  contents.on('did-navigate', () => {
    deps.invalidateOpenOwner(contents)
    responder.navigationCommitted()
    if (close.isAwaiting()) finishClose(close.rendererLost())
  })
  const preventUntrustedNavigation = (event: Electron.Event, url: string): void => {
    if (rendererUrlIsTrusted(url, deps.developmentRendererUrl)) return
    event.preventDefault()
    const external = externalWebUrl(url)
    if (external) void shell.openExternal(external)
  }
  contents.on('will-navigate', (event) => preventUntrustedNavigation(event, event.url))
  contents.on('will-redirect', (event) => preventUntrustedNavigation(event, event.url))
  window.on('unresponsive', () => deps.logIncident('window-unresponsive', {}))
  window.on('responsive', () => deps.logIncident('window-responsive-again', {}))

  let quitRequested = false
  const onBeforeQuit = (): void => {
    quitRequested = true
  }
  app.on('before-quit', onBeforeQuit)
  window.on('close', (event) => {
    if (!needsCloseConfirmation(close.isAllowed(), responder.isReady(), contents.isDestroyed())) {
      return
    }
    const request = close.request(quitRequested)
    quitRequested = false
    if (request.kind === 'allow') return
    event.preventDefault()
    if (request.kind === 'waiting') return
    const lease = responder.activeLeaseId()
    if (lease === null || !sendIfAlive(window, 'close-requested', request.requestId, lease)) {
      responder.rendererLost()
      finishClose(close.rendererLost())
    }
  })

  const isCurrentMainFrame = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    event.sender === contents && deps.isTrustedMainFrame(event)
  const ownsResponder = (event: IpcMainEvent, lease: unknown): boolean =>
    isCurrentMainFrame(event) && responder.owns(lease)
  const onCloseConfirmed = (event: IpcMainEvent, requestId: unknown, lease: unknown): void => {
    if (ownsResponder(event, lease)) finishClose(close.confirm(requestId))
  }
  const onCloseCancelled = (event: IpcMainEvent, requestId: unknown, lease: unknown): void => {
    if (ownsResponder(event, lease) && close.cancel(requestId)) deps.closeCancelled()
  }
  const onResponderClaim = (event: IpcMainInvokeEvent): number => {
    if (!isCurrentMainFrame(event)) throw new Error('Close responder is unavailable.')
    return responder.claim()
  }
  const onResponderActivate = (event: IpcMainEvent, lease: unknown): void => {
    if (!isCurrentMainFrame(event) || !responder.activate(lease)) return
    const requestId = close.pendingRequestId()
    const activeLease = responder.activeLeaseId()
    if (
      requestId !== null &&
      (activeLease === null || !sendIfAlive(window, 'close-requested', requestId, activeLease))
    ) {
      responder.rendererLost()
      finishClose(close.rendererLost())
    }
  }
  const onResponderRelease = (event: IpcMainEvent, lease: unknown): void => {
    if (!isCurrentMainFrame(event)) return
    if (responder.release(lease) && close.isAwaiting()) finishClose(close.rendererLost())
  }

  ipcMain.handle('close-responder-claim', onResponderClaim)
  ipcMain.on('close-responder-activate', onResponderActivate)
  ipcMain.on('close-confirmed', onCloseConfirmed)
  ipcMain.on('close-cancelled', onCloseCancelled)
  ipcMain.on('close-responder-release', onResponderRelease)
  window.on('closed', () => {
    deps.invalidateOpenOwner(contents)
    ipcMain.removeHandler('close-responder-claim')
    ipcMain.removeListener('close-responder-activate', onResponderActivate)
    ipcMain.removeListener('close-confirmed', onCloseConfirmed)
    ipcMain.removeListener('close-cancelled', onCloseCancelled)
    ipcMain.removeListener('close-responder-release', onResponderRelease)
    app.removeListener('before-quit', onBeforeQuit)
  })

  contents.setWindowOpenHandler((details) => {
    const external = externalWebUrl(details.url)
    if (external) void shell.openExternal(external)
    return { action: 'deny' }
  })
  if (deps.developmentRendererUrl) window.loadURL(deps.developmentRendererUrl)
  else window.loadURL(`${RENDERER_ORIGIN}/index.html`)
  return window
}
