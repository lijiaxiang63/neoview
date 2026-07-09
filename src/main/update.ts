import { app, ipcMain, net, shell, BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import { createWriteStream, readFileSync, promises as fs } from 'fs'
import { createHash } from 'crypto'
import { once } from 'events'
import { finished } from 'stream/promises'
import { join } from 'path'
import { findUpdate, type UpdateInfo } from './updateCheck'
import type { UpdateStatus } from '../preload/updates'

const RELEASE_API = 'https://api.github.com/repos/lijiaxiang63/neoview/releases/latest'
const CHECK_TIMEOUT_MS = 15_000
// Late enough that the first check never competes with app startup.
const STARTUP_CHECK_DELAY_MS = 10_000
const PROGRESS_INTERVAL_MS = 150

interface UpdateSettings {
  autoCheck: boolean
  /** Version the user chose to skip; auto-checks stay quiet about it. */
  skippedVersion: string | null
}

let settingsPath = ''
let settings: UpdateSettings = { autoCheck: true, skippedVersion: null }

function loadSettings(): void {
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8'))
    settings = {
      autoCheck: typeof raw.autoCheck === 'boolean' ? raw.autoCheck : true,
      skippedVersion: typeof raw.skippedVersion === 'string' ? raw.skippedVersion : null
    }
  } catch {
    // First run or unreadable file: keep defaults.
  }
}

function saveSettings(): void {
  void fs.writeFile(settingsPath, JSON.stringify(settings, null, 2)).catch(() => {})
}

export function autoCheckEnabled(): boolean {
  return settings.autoCheck
}

export function setAutoCheck(enabled: boolean): void {
  settings.autoCheck = enabled
  saveSettings()
}

function sendStatus(win: BrowserWindow, status: UpdateStatus): void {
  if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('update-status', status)
  }
}

const userAgent = (): string => `neoview/${app.getVersion()}`

let checking = false
// Whether the in-flight check must report its result to a manual caller. A
// silent auto-check only speaks up on an available update, so a manual request
// that arrives mid-flight promotes this — otherwise the user gets no reply.
let reportManual = false
let pendingUpdate: UpdateInfo | null = null

export async function checkForUpdates(win: BrowserWindow, manual: boolean): Promise<void> {
  if (checking) {
    if (manual && !reportManual) {
      reportManual = true
      sendStatus(win, { kind: 'checking', manual: true })
    }
    return
  }
  checking = true
  reportManual = manual
  if (reportManual) sendStatus(win, { kind: 'checking', manual: true })
  try {
    // net.fetch (here and in downloadUpdate) goes through Chromium's network
    // stack, so system proxy settings apply — Node's global fetch ignores them.
    const res = await net.fetch(RELEASE_API, {
      headers: { 'User-Agent': userAgent(), Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`release lookup returned HTTP ${res.status}`)
    const release = await res.json()
    const update = findUpdate(release, app.getVersion(), process.platform, process.arch)
    if (!update) {
      if (reportManual) sendStatus(win, { kind: 'none', manual: true, version: app.getVersion() })
    } else if (!reportManual && update.version === settings.skippedVersion) {
      // The user skipped this version; stay quiet until the next one.
    } else {
      pendingUpdate = update
      sendStatus(win, {
        kind: 'available',
        manual: reportManual,
        version: update.version,
        notesUrl: update.notesUrl,
        assetName: update.asset.name,
        assetSize: update.asset.size
      })
    }
  } catch (err) {
    if (reportManual) {
      const message = err instanceof Error ? err.message : 'update check failed'
      sendStatus(win, { kind: 'error', manual: true, message })
    }
  } finally {
    checking = false
    reportManual = false
  }
}

let downloadAbort: AbortController | null = null

/** Resolves with the downloaded file path, or null when cancelled. */
async function downloadUpdate(win: BrowserWindow): Promise<string | null> {
  const update = pendingUpdate
  if (!update) throw new Error('No update available to download.')
  downloadAbort?.abort()
  const abort = new AbortController()
  downloadAbort = abort
  const dir = await fs.mkdtemp(join(app.getPath('temp'), 'neoview-update-'))
  const filePath = join(dir, update.asset.name)
  let out: ReturnType<typeof createWriteStream> | null = null
  try {
    const res = await net.fetch(update.asset.url, {
      headers: { 'User-Agent': userAgent() },
      signal: abort.signal
    })
    if (!res.ok || !res.body) throw new Error(`download returned HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length')) || update.asset.size
    const hash = update.asset.digest?.startsWith('sha256:') ? createHash('sha256') : null
    out = createWriteStream(filePath)
    // Swallow raw 'error' events; once()/finished() below still surface them.
    out.on('error', () => {})
    let received = 0
    let lastProgress = 0
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash?.update(chunk)
      received += chunk.byteLength
      if (!out.write(chunk)) await once(out, 'drain')
      const now = Date.now()
      if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
        lastProgress = now
        if (!win.isDestroyed()) win.webContents.send('update-progress', { received, total })
      }
    }
    out.end()
    await finished(out)
    if (hash && `sha256:${hash.digest('hex')}` !== update.asset.digest) {
      throw new Error('Downloaded file failed its integrity check.')
    }
    if (!win.isDestroyed()) win.webContents.send('update-progress', { received, total: received })
    downloadedPath = filePath
    return filePath
  } catch (err) {
    out?.destroy()
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    if (abort.signal.aborted) return null
    throw err
  } finally {
    if (downloadAbort === abort) downloadAbort = null
  }
}

/** Set only by a completed download; the renderer never supplies paths. */
let downloadedPath: string | null = null

let installerPath: string | null = null

/**
 * Hand off to the downloaded installer as the app quits, so it never races
 * the running instance. Runs on 'will-quit', i.e. only after the renderer's
 * unsaved-edits veto has let the quit through. If that veto cancels the quit,
 * 'close-cancelled' disarms this first so a later unrelated quit stays inert.
 */
function launchInstallerOnQuit(): void {
  if (!installerPath) return
  const path = installerPath
  installerPath = null
  const child =
    process.platform === 'darwin'
      ? spawn('open', [path], { detached: true, stdio: 'ignore' })
      : spawn(path, [], { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

export function initUpdater(getWindow: () => BrowserWindow | null): void {
  settingsPath = join(app.getPath('userData'), 'update-settings.json')
  loadSettings()

  ipcMain.handle('update-download', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    return downloadUpdate(win)
  })

  ipcMain.on('update-download-cancel', () => downloadAbort?.abort())

  ipcMain.handle('update-install', async () => {
    const path = downloadedPath
    if (!path) throw new Error('No downloaded update to install.')
    if (process.platform === 'linux') {
      // No self-install story here: make the file runnable and reveal it.
      if (path.toLowerCase().endsWith('.appimage')) await fs.chmod(path, 0o755).catch(() => {})
      shell.showItemInFolder(path)
      return { quits: false }
    }
    installerPath = path
    app.quit()
    return { quits: true }
  })

  ipcMain.on('update-skip', (_event, version: string) => {
    if (typeof version === 'string' && version) {
      settings.skippedVersion = version
      saveSettings()
    }
  })

  // The install hand-off quits via the renderer's close flow; if the user
  // vetoes that quit, drop the armed installer so it never fires on a later one.
  ipcMain.on('close-cancelled', () => {
    installerPath = null
  })

  app.on('will-quit', launchInstallerOnQuit)

  setTimeout(() => {
    if (!settings.autoCheck) return
    const win = getWindow()
    if (win) void checkForUpdates(win, false)
  }, STARTUP_CHECK_DELAY_MS)
}
