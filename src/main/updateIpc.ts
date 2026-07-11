import { isUpdateCommandId, type UpdateInstallResult, type UpdateSnapshot } from '../shared/updates'
import type { UpdateController } from './updateService'
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type { RendererMainFrameGate } from './rendererProtocol'

type InvokeHandler = (...args: unknown[]) => unknown
type EventHandler = (...args: unknown[]) => void

/** Narrow, injectable IPC surface. Each registration returns its own
 * disposer so partial setup can be rolled back without relying on globals. */
export interface UpdateIpcPort {
  handle(channel: string, handler: InvokeHandler): () => void
  listen(channel: string, handler: EventHandler): () => void
}

/** Preserve the Electron event until the centralized renderer-frame gate has
 * authorized it, then expose only command payloads to the pure state machine. */
export function createUpdateIpcPort(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeListener'>,
  isTrustedMainFrame: RendererMainFrameGate
): UpdateIpcPort {
  return {
    handle(channel, handler) {
      ipc.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        if (!isTrustedMainFrame(event)) throw new Error('Update operation is unavailable.')
        return handler(...args)
      })
      return () => ipc.removeHandler(channel)
    },
    listen(channel, handler) {
      const listener = (event: IpcMainEvent, ...args: unknown[]): void => {
        if (isTrustedMainFrame(event)) handler(...args)
      }
      ipc.on(channel, listener)
      return () => ipc.removeListener(channel, listener)
    }
  }
}

export interface UpdateIpcDependencies {
  port: UpdateIpcPort
  controller: Pick<
    UpdateController,
    | 'snapshot'
    | 'download'
    | 'cancelDownload'
    | 'skip'
    | 'dismiss'
    | 'installFailed'
    | 'autoCheckEnabled'
    | 'setAutoCheck'
  >
  publish(snapshot: UpdateSnapshot): void
  install(commandId: number): Promise<UpdateInstallResult>
  /** A renderer changed the auto-check preference; lets the composition root
   * mirror the application menu's checkbox. */
  onAutoCheckChanged?(enabled: boolean): void
}

/** Register the complete updater IPC contract as one disposable unit. Every
 * renderer mutation is command-owned; malformed payloads only replay the
 * current authoritative snapshot. */
export function registerUpdateIpc(deps: UpdateIpcDependencies): () => void {
  const { controller, port } = deps
  const disposers: Array<() => void> = []
  let active = true

  const replay = (): void => deps.publish(controller.snapshot())
  const keep = (dispose: () => void): void => {
    disposers.push(dispose)
  }
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
    keep(port.handle('update-state', () => controller.snapshot()))
    keep(
      port.handle('update-download', (commandId) => {
        if (!isUpdateCommandId(commandId)) {
          replay()
          return null
        }
        return controller.download(commandId)
      })
    )
    keep(
      port.handle('update-install', async (commandId): Promise<UpdateInstallResult> => {
        if (!isUpdateCommandId(commandId) || commandId !== controller.snapshot().commandId) {
          replay()
          return { quits: false }
        }
        try {
          return await deps.install(commandId)
        } catch (error) {
          controller.installFailed(
            commandId,
            error instanceof Error ? error.message : 'Install failed.'
          )
          throw error
        }
      })
    )
    keep(
      port.listen('update-download-cancel', (commandId) => {
        if (!isUpdateCommandId(commandId)) {
          replay()
          return
        }
        controller.cancelDownload(commandId)
      })
    )
    keep(
      port.listen('update-skip', (version, commandId) => {
        if (typeof version !== 'string' || !version || !isUpdateCommandId(commandId)) {
          replay()
          return
        }
        controller.skip(version, commandId)
      })
    )
    keep(
      port.listen('update-dismiss', (commandId) => {
        if (!isUpdateCommandId(commandId)) {
          replay()
          return
        }
        controller.dismiss(commandId)
      })
    )
    keep(port.handle('update-auto-check', () => controller.autoCheckEnabled()))
    keep(
      port.listen('update-auto-check-set', (enabled) => {
        if (typeof enabled !== 'boolean') return
        controller.setAutoCheck(enabled)
        deps.onAutoCheckChanged?.(enabled)
      })
    )
  } catch (error) {
    dispose()
    throw error
  }

  return dispose
}
