import { describe, expect, it, vi } from 'vitest'
import { createApplicationMenuTemplate, type ApplicationMenuOptions } from '../src/main/menu'

function options(isMac: boolean): ApplicationMenuOptions {
  const action = vi.fn()
  return {
    isMac,
    appName: 'Neoview',
    viewState: {
      fileList: true,
      sidePanel: false,
      folderOpen: true,
      directionLabels: true,
      crosshair: false
    },
    recentItems: [{ path: '/a.nii', label: 'a.nii' }],
    actions: {
      openFile: action,
      openFolder: action,
      openRecent: action,
      clearRecent: action,
      openBuiltinBase: action,
      openBuiltinOverlay: action,
      showShortcuts: action,
      undo: action,
      redo: action,
      toggleFilePanel: action,
      toggleSidePanel: action,
      toggleDirectionLabels: action,
      toggleCrosshair: action,
      showPreferences: action,
      openHomepage: action,
      openRepository: action,
      checkForUpdates: action
    }
  }
}

describe('application menu template', () => {
  it('maps view state and recent commands without Electron side effects', () => {
    const input = options(false)
    const template = createApplicationMenuTemplate(input)
    const file = template.find((item) => item.label === 'File')!
    const view = template.find((item) => item.label === 'View')!
    const fileItems = file.submenu as Electron.MenuItemConstructorOptions[]
    const viewItems = view.submenu as Electron.MenuItemConstructorOptions[]
    const recent = fileItems.find((item) => item.label === 'Open Recent')!
    const recentItems = recent.submenu as Electron.MenuItemConstructorOptions[]

    expect(template.some((item) => item.label === 'Edit')).toBe(false)
    expect(viewItems.find((item) => item.id === 'view-file-list')).toMatchObject({
      checked: true,
      enabled: true
    })
    expect(viewItems.find((item) => item.id === 'view-side-panel')).toMatchObject({
      checked: false
    })
    expect(viewItems.find((item) => item.id === 'view-direction-labels')).toMatchObject({
      checked: true
    })
    expect(viewItems.find((item) => item.id === 'view-crosshair')).toMatchObject({
      checked: false
    })
    expect(viewItems.filter((item) => item.role === 'togglefullscreen')).toHaveLength(1)
    recentItems[0].click?.({} as never, {} as never, {} as never)
    expect(input.actions.openRecent).toHaveBeenCalledWith('/a.nii')
  })

  it('places one Settings… item with the standard accelerator per platform', () => {
    const mac = options(true)
    const macTemplate = createApplicationMenuTemplate(mac)
    const appItems = macTemplate[0].submenu as Electron.MenuItemConstructorOptions[]
    const macSettings = appItems.find((item) => item.label === 'Settings…')!
    expect(macSettings.accelerator).toBe('CmdOrCtrl+,')
    macSettings.click?.({} as never, {} as never, {} as never)
    expect(mac.actions.showPreferences).toHaveBeenCalledTimes(1)
    const macFile = macTemplate.find((item) => item.label === 'File')!
    expect(
      (macFile.submenu as Electron.MenuItemConstructorOptions[]).some(
        (item) => item.label === 'Settings…'
      )
    ).toBe(false)

    const other = createApplicationMenuTemplate(options(false))
    const fileItems = other.find((item) => item.label === 'File')!
      .submenu as Electron.MenuItemConstructorOptions[]
    const settings = fileItems.find((item) => item.label === 'Settings…')!
    expect(settings.accelerator).toBe('CmdOrCtrl+,')
  })

  it('offers only the explicit update check — the automatic toggle lives in settings', () => {
    for (const isMac of [true, false]) {
      const template = createApplicationMenuTemplate(options(isMac))
      const holder = isMac
        ? (template[0].submenu as Electron.MenuItemConstructorOptions[])
        : (template.find((item) => item.label === 'Help')!
            .submenu as Electron.MenuItemConstructorOptions[])
      expect(holder.some((item) => item.label === 'Check for Updates…')).toBe(true)
      expect(holder.some((item) => item.type === 'checkbox')).toBe(false)
    }
  })

  it('adds the macOS application and edit menus', () => {
    const template = createApplicationMenuTemplate(options(true))
    expect(template[0].label).toBe('Neoview')
    expect(template.some((item) => item.label === 'Edit')).toBe(true)
    const view = template.find((item) => item.label === 'View')!
    const viewItems = view.submenu as Electron.MenuItemConstructorOptions[]
    expect(viewItems.filter((item) => item.role === 'togglefullscreen')).toHaveLength(0)
    expect(template.some((item) => item.role === 'windowMenu')).toBe(true)
  })
})
