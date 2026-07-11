import { app, type BrowserWindow, type WebContents } from 'electron'
import { resolve } from 'path'
import { isVolumeFileName } from './files/names'

export function volumePathFromArgv(args: readonly string[], cwd: string): string | null {
  for (let index = args.length - 1; index >= 0; index--) {
    const value = args[index]
    if (!value.startsWith('-') && isVolumeFileName(value)) return resolve(cwd, value)
  }
  return null
}

/** Register operating-system launch/open routing before application readiness.
 * The queue holds only the newest pending intent until a renderer can receive it. */
export function installLaunchFileRouting<Scope>(deps: {
  getWindow(): BrowserWindow | null
  issueIntent(): number
  captureWindow(window: BrowserWindow | null, requireLoaded: boolean): Scope | null
  captureContents(contents: WebContents): Scope
  open(window: BrowserWindow, path: string, intent: number, scope: Scope): Promise<void>
  isExcludedContents(contentsId: number): boolean
}): boolean {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return false
  }

  let pending: { path: string; intent: number } | null = null
  app.on('open-file', (event, path) => {
    event.preventDefault()
    if (!isVolumeFileName(path)) return
    const intent = deps.issueIntent()
    const window = deps.getWindow()
    const scope = deps.captureWindow(window, true)
    if (window && scope) void deps.open(window, path, intent, scope)
    else pending = { path, intent }
  })

  const startupPath = volumePathFromArgv(process.argv.slice(1), process.cwd())
  pending = startupPath ? { path: startupPath, intent: deps.issueIntent() } : null
  app.on('browser-window-created', (_event, window) => {
    const contents = window.webContents
    const contentsId = contents.id
    contents.on('did-finish-load', () => {
      if (deps.isExcludedContents(contentsId) || !pending) return
      const { path, intent } = pending
      pending = null
      const scope = deps.captureContents(contents)
      setTimeout(() => void deps.open(window, path, intent, scope), 250)
    })
  })

  app.on('second-instance', (_event, argv, workingDirectory) => {
    const window = deps.getWindow()
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
    const path = volumePathFromArgv(argv.slice(1), workingDirectory)
    if (!path) return
    const intent = deps.issueIntent()
    const scope = deps.captureWindow(window, true)
    if (window && scope) void deps.open(window, path, intent, scope)
    else pending = { path, intent }
  })
  return true
}
