/** A hidden bootstrap/migration window may temporarily be the only Electron
 * window. Closing it must not terminate the process before the first visible
 * application window is created. */
export function shouldQuitAfterAllWindowsClosed(
  platform: NodeJS.Platform,
  initialWindowPending: boolean,
  applicationWindowCount: number
): boolean {
  return platform !== 'darwin' && !initialWindowPending && applicationWindowCount === 0
}

export function shouldCreateWindowOnActivate(
  applicationWindowCount: number,
  quitAllowsWindowCreation: boolean
): boolean {
  return quitAllowsWindowCreation && applicationWindowCount === 0
}
