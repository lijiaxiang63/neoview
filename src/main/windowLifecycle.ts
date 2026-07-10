export interface MessageWebContents {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

export interface MessageWindow {
  isDestroyed(): boolean
  webContents: MessageWebContents
}

/** Deliver only while both Electron owners are alive; send itself can still
 * race destruction, so a final exception is intentionally contained. */
export function sendIfAlive(window: MessageWindow, channel: string, ...args: unknown[]): boolean {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return false
  try {
    window.webContents.send(channel, ...args)
    return true
  } catch {
    return false
  }
}

export function needsCloseConfirmation(
  allowClose: boolean,
  rendererAvailable: boolean,
  webContentsDestroyed: boolean
): boolean {
  return !allowClose && rendererAvailable && !webContentsDestroyed
}
