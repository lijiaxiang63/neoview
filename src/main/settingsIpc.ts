import { SETTINGS_CHANNELS, type AppSettings } from '../shared/settings'
import type { AppSettingsStore } from './appSettings'
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { RendererMainFrameGate } from './rendererProtocol'

export interface SettingsIpcDependencies {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeListener'>
  store: Pick<AppSettingsStore, 'snapshot' | 'patch'>
  isTrustedMainFrame: RendererMainFrameGate
  /** Deliver one authoritative snapshot to every live window. */
  broadcast(settings: AppSettings): void
}

/** Register the application-settings IPC contract as one disposable unit.
 * Every renderer write is validated main-side; the resulting authoritative
 * snapshot is broadcast so the application and settings windows converge. */
export function registerSettingsIpc(deps: SettingsIpcDependencies): () => void {
  const { ipc, store, isTrustedMainFrame } = deps
  const disposers: Array<() => void> = []
  let active = true

  const dispose = (): void => {
    if (!active) return
    active = false
    for (const release of disposers.splice(0).reverse()) {
      try {
        release()
      } catch {
        // Continue releasing the rest of the registration unit.
      }
    }
  }

  try {
    ipc.handle(SETTINGS_CHANNELS.get, (event: IpcMainInvokeEvent): AppSettings => {
      if (!isTrustedMainFrame(event)) throw new Error('Settings are unavailable.')
      return store.snapshot()
    })
    disposers.push(() => ipc.removeHandler(SETTINGS_CHANNELS.get))

    const onSet = (event: IpcMainEvent, patch: unknown): void => {
      if (!isTrustedMainFrame(event)) return
      deps.broadcast(store.patch(patch))
    }
    ipc.on(SETTINGS_CHANNELS.set, onSet)
    disposers.push(() => ipc.removeListener(SETTINGS_CHANNELS.set, onSet))
  } catch (error) {
    dispose()
    throw error
  }

  return dispose
}
