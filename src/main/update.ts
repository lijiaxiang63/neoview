import { app, ipcMain, net, shell, BrowserWindow } from 'electron'
import { spawn } from 'child_process'
import { createWriteStream, readFileSync, promises as fs } from 'fs'
import { createHash } from 'crypto'
import { once } from 'events'
import { finished } from 'stream/promises'
import { dirname, join } from 'path'
import { findUpdate, type UpdateInfo } from './updateCheck'
import {
  createUpdateController,
  FinalQuitInstaller,
  PendingTasks,
  prepareSavedProduct,
  releaseFailedDownload,
  RetainedCleanup,
  settleUpdateShutdown,
  type UpdateSettings
} from './updateService'
import type { UpdateInstallResult, UpdateSnapshot } from '../shared/updates'
import { sendIfAlive } from './windowLifecycle'
import { createUpdateIpcPort, registerUpdateIpc } from './updateIpc'
import type { RendererMainFrameGate } from './rendererProtocol'

const RELEASE_API = 'https://api.github.com/repos/lijiaxiang63/neoview/releases/latest'
const CHECK_TIMEOUT_MS = 15_000
const STARTUP_CHECK_DELAY_MS = 10_000
const PROGRESS_INTERVAL_MS = 150

export interface UpdateService {
  autoCheckEnabled(): boolean
  setAutoCheck(enabled: boolean): void
  checkForUpdates(manual: boolean): Promise<void>
  closeCancelled(): void
  finalizeQuit(): void
  dispose(): Promise<void>
}

function loadSettings(path: string): UpdateSettings {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return {
      autoCheck: typeof raw.autoCheck === 'boolean' ? raw.autoCheck : true,
      skippedVersion: typeof raw.skippedVersion === 'string' ? raw.skippedVersion : null
    }
  } catch {
    return { autoCheck: true, skippedVersion: null }
  }
}

const userAgent = (): string => `Neoview/${app.getVersion()}`

async function findAvailableUpdate(signal: AbortSignal): Promise<UpdateInfo | null> {
  const response = await net.fetch(RELEASE_API, {
    headers: { 'User-Agent': userAgent(), Accept: 'application/vnd.github+json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)])
  })
  if (!response.ok) throw new Error(`release lookup returned HTTP ${response.status}`)
  return findUpdate(await response.json(), app.getVersion(), process.platform, process.arch)
}

async function downloadUpdate(
  update: UpdateInfo,
  signal: AbortSignal,
  onProgress: (received: number, total: number) => void,
  releaseDirectory: (path: string) => Promise<void>
): Promise<string | null> {
  const dir = await fs.mkdtemp(join(app.getPath('temp'), 'neoview-update-'))
  const filePath = join(dir, update.asset.name)
  let out: ReturnType<typeof createWriteStream> | null = null
  try {
    const response = await net.fetch(update.asset.url, {
      headers: { 'User-Agent': userAgent() },
      signal
    })
    if (!response.ok || !response.body) {
      throw new Error(`download returned HTTP ${response.status}`)
    }
    const total = Number(response.headers.get('content-length')) || update.asset.size
    const hash = update.asset.digest?.startsWith('sha256:') ? createHash('sha256') : null
    out = createWriteStream(filePath)
    out.on('error', () => {})
    let received = 0
    let lastProgress = 0
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      hash?.update(chunk)
      received += chunk.byteLength
      if (!out.write(chunk)) await once(out, 'drain')
      const now = Date.now()
      if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
        lastProgress = now
        onProgress(received, total)
      }
    }
    out.end()
    await finished(out)
    if (hash && `sha256:${hash.digest('hex')}` !== update.asset.digest) {
      throw new Error('Downloaded file failed its integrity check.')
    }
    onProgress(received, received)
    return filePath
  } catch (error) {
    const output = out
    await releaseFailedDownload(output, () => releaseDirectory(dir))
    if (signal.aborted) return null
    throw error
  }
}

/** Owns updater state, IPC, startup scheduling, cancellation and install
 * hand-off as one disposable application service. */
export function createUpdateService(
  getWindow: () => BrowserWindow | null,
  isTrustedMainFrame: RendererMainFrameGate
): UpdateService {
  const settingsPath = join(app.getPath('userData'), 'update-settings.json')
  let disposePromise: Promise<void> | null = null
  const installer = new FinalQuitInstaller()
  const installTasks = new PendingTasks()
  const directoryCleanup = new RetainedCleanup((path) =>
    fs.rm(path, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100
    })
  )

  const publish = (snapshot: UpdateSnapshot): void => {
    const window = getWindow()
    if (window) sendIfAlive(window, 'update-state', snapshot)
  }

  const controller = createUpdateController({
    currentVersion: app.getVersion(),
    settings: loadSettings(settingsPath),
    check: findAvailableUpdate,
    download: (update, signal, onProgress) =>
      downloadUpdate(update, signal, onProgress, directoryCleanup.release.bind(directoryCleanup)),
    saveSettings: (settings) => fs.writeFile(settingsPath, JSON.stringify(settings, null, 2)),
    releaseDownloaded: (path) => directoryCleanup.release(dirname(path)),
    onState: publish
  })

  const port = createUpdateIpcPort(ipcMain, isTrustedMainFrame)
  const disposeIpc = registerUpdateIpc({
    port,
    controller,
    publish,
    install: (commandId): Promise<UpdateInstallResult> =>
      installTasks.track(
        Promise.resolve().then(async (): Promise<UpdateInstallResult> => {
          const path = controller.downloadedPath()
          if (!path) throw new Error('No downloaded update to install.')
          if (process.platform === 'linux') {
            const saved = await prepareSavedProduct(controller, commandId, path, {
              prepare: async (ownedPath) => {
                if (ownedPath.toLowerCase().endsWith('.appimage')) await fs.chmod(ownedPath, 0o755)
              },
              reveal: (ownedPath) => shell.showItemInFolder(ownedPath)
            })
            if (!saved) throw new Error('Downloaded update is no longer available.')
            return { quits: false }
          }
          installer.arm(path)
          app.quit()
          return { quits: true }
        })
      )
  })

  const finalizeQuit = (): void => {
    // Cleanup marks the hand-off ready before main performs its explicit final
    // exit. Taking the path is one-shot, including repeated callback attempts.
    if (!installer.isReady()) return
    const path = installer.take()
    if (!path) return
    const child =
      process.platform === 'darwin'
        ? spawn('open', [path], { detached: true, stdio: 'ignore' })
        : spawn(path, [], { detached: true, stdio: 'ignore', cwd: dirname(path) })
    child.on('error', () => {})
    child.unref()
  }

  const startupTimer = setTimeout(() => {
    if (controller.autoCheckEnabled()) void controller.check(false)
  }, STARTUP_CHECK_DELAY_MS)

  return {
    autoCheckEnabled: controller.autoCheckEnabled,
    setAutoCheck: controller.setAutoCheck,
    checkForUpdates: controller.check,
    closeCancelled() {
      installer.cancel()
    },
    finalizeQuit,
    dispose() {
      if (disposePromise) return disposePromise
      clearTimeout(startupTimer)
      installer.prepare(controller.handoffDownloaded)
      disposeIpc()
      controller.dispose()
      disposePromise = settleUpdateShutdown(
        controller.settingsSettled(),
        Promise.all([controller.resourcesSettled(), installTasks.settle()]).then(() => undefined),
        directoryCleanup,
        () => installer.markReady()
      )
      return disposePromise
    }
  }
}
