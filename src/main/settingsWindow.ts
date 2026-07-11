import { BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'path'
import { externalWebUrl, RENDERER_ORIGIN, rendererUrlIsTrusted } from './rendererProtocol'

export interface SettingsWindowDependencies {
  icon: string
  developmentRendererUrl: string | null
  /** Keeps the window out of the application-window count so activation,
   * quit-on-last-window and launch-file routing ignore it. */
  registerAuxiliary(contentsId: number): void
  releaseAuxiliary(contentsId: number): void
  logIncident(kind: string, details: unknown): void
}

export interface SettingsWindowHost {
  /** Open the singleton settings window, or focus the existing one. */
  open(): void
  /** Close the window if it exists (e.g. the last application window went away). */
  closeIfOpen(): void
}

/** Singleton native settings window. It carries no document state and no
 * close-confirmation gate; closing it is always allowed. */
export function createSettingsWindowHost(deps: SettingsWindowDependencies): SettingsWindowHost {
  let window: BrowserWindow | null = null

  const open = (): void => {
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore()
      window.focus()
      return
    }
    const created = new BrowserWindow({
      title: 'Settings',
      width: 460,
      height: 560,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d10' : '#e7e9ee',
      ...(process.platform === 'linux' ? { icon: deps.icon } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    const contents = created.webContents
    deps.registerAuxiliary(contents.id)
    created.on('ready-to-show', () => created.show())
    created.on('closed', () => {
      deps.releaseAuxiliary(contents.id)
      if (window === created) window = null
    })
    // A window that never reaches ready-to-show would otherwise survive as an
    // invisible singleton that every later open() focuses. Destroying it lets
    // the next open() recreate a working one ('closed' still runs).
    contents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 /* aborted */) return
      deps.logIncident('settings-window-load-failed', { errorCode, errorDescription })
      if (!created.isDestroyed()) created.destroy()
    })
    contents.on('render-process-gone', (_event, details) => {
      deps.logIncident('settings-window-render-process-gone', details)
      if (!created.isDestroyed()) created.destroy()
    })

    const preventUntrustedNavigation = (event: Electron.Event, url: string): void => {
      if (rendererUrlIsTrusted(url, deps.developmentRendererUrl)) return
      event.preventDefault()
      const external = externalWebUrl(url)
      if (external) void shell.openExternal(external)
    }
    contents.on('will-navigate', (event) => preventUntrustedNavigation(event, event.url))
    contents.on('will-redirect', (event) => preventUntrustedNavigation(event, event.url))
    contents.setWindowOpenHandler((details) => {
      const external = externalWebUrl(details.url)
      if (external) void shell.openExternal(external)
      return { action: 'deny' }
    })

    if (deps.developmentRendererUrl) {
      created.loadURL(new URL('settings.html', deps.developmentRendererUrl).toString())
    } else {
      created.loadURL(`${RENDERER_ORIGIN}/settings.html`)
    }
    window = created
  }

  return {
    open,
    closeIfOpen() {
      if (window && !window.isDestroyed()) window.close()
    }
  }
}
