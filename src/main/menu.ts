import type { MenuItemConstructorOptions } from 'electron'
import type { FilePanelState } from '../shared/files'

export interface ApplicationMenuOptions {
  isMac: boolean
  appName: string
  viewState: FilePanelState
  recentItems: Array<{ path: string; label: string }>
  autoCheckEnabled: boolean
  actions: {
    openFile(): void
    openFolder(): void
    openRecent(path: string): void
    clearRecent(): void
    openBuiltinBase(): void
    openBuiltinOverlay(): void
    showShortcuts(): void
    undo(): void
    redo(): void
    toggleFilePanel(): void
    toggleSidePanel(): void
    openHomepage(): void
    openRepository(): void
    checkForUpdates(): void
    setAutoCheck(enabled: boolean): void
  }
}

/** Pure application-menu description. Electron side effects and file-open
 * ownership stay in the composition root; this module only maps state and
 * commands into the platform template. */
export function createApplicationMenuTemplate(
  options: ApplicationMenuOptions
): MenuItemConstructorOptions[] {
  const { isMac, appName, viewState, recentItems, autoCheckEnabled, actions } = options
  const links: MenuItemConstructorOptions[] = [
    { label: 'Website', click: actions.openHomepage },
    { label: 'GitHub Repository', click: actions.openRepository }
  ]
  const shortcuts: MenuItemConstructorOptions = {
    label: 'Keyboard Shortcuts',
    click: actions.showShortcuts
  }
  const recents: MenuItemConstructorOptions[] =
    recentItems.length === 0
      ? [{ label: 'No Recent Files', enabled: false }]
      : [
          ...recentItems.map(({ path, label }) => ({
            label,
            click: () => actions.openRecent(path)
          })),
          { type: 'separator' as const },
          { label: 'Clear Menu', click: actions.clearRecent }
        ]
  const updates: MenuItemConstructorOptions[] = [
    { label: 'Check for Updates…', click: actions.checkForUpdates },
    {
      label: 'Check for Updates Automatically',
      type: 'checkbox',
      checked: autoCheckEnabled,
      click: (item) => actions.setAutoCheck(item.checked)
    }
  ]
  const macAppMenu: MenuItemConstructorOptions = {
    label: appName,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      ...updates,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  }

  return [
    ...(isMac ? [macAppMenu] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: actions.openFile },
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: actions.openFolder
        },
        { label: 'Open Recent', submenu: recents },
        { type: 'separator' },
        { label: 'Open Built-in Volume', click: actions.openBuiltinBase },
        { label: 'Open Built-in Overlay', click: actions.openBuiltinOverlay },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    ...(isMac
      ? [
          {
            label: 'Edit',
            submenu: [
              { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: actions.undo },
              { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: actions.redo },
              { type: 'separator' as const },
              { role: 'cut' as const },
              { role: 'copy' as const },
              { role: 'paste' as const },
              { role: 'selectAll' as const }
            ]
          } satisfies MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'View',
      submenu: [
        {
          id: 'view-file-list',
          label: 'File List',
          type: 'checkbox',
          checked: viewState.folderOpen && viewState.fileList,
          enabled: viewState.folderOpen,
          accelerator: 'CmdOrCtrl+Shift+B',
          click: actions.toggleFilePanel
        },
        {
          id: 'view-side-panel',
          label: 'Side Panel',
          type: 'checkbox',
          checked: viewState.sidePanel,
          accelerator: 'CmdOrCtrl+B',
          click: actions.toggleSidePanel
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    },
    ...(isMac ? [{ role: 'windowMenu' as const }] : []),
    isMac
      ? {
          role: 'help' as const,
          submenu: [shortcuts, { type: 'separator' as const }, ...links]
        }
      : {
          label: 'Help',
          submenu: [
            shortcuts,
            { type: 'separator' as const },
            ...links,
            { type: 'separator' as const },
            ...updates,
            { type: 'separator' as const },
            { role: 'about' as const }
          ]
        }
  ]
}
