import { describe, expect, it, vi } from 'vitest'
import { createApplicationMenuTemplate, type ApplicationMenuOptions } from '../src/main/menu'

function options(isMac: boolean): ApplicationMenuOptions {
  const action = vi.fn()
  return {
    isMac,
    appName: 'neoview',
    viewState: { fileList: true, sidePanel: false, folderOpen: true },
    recentItems: [{ path: '/a.nii', label: 'a.nii' }],
    autoCheckEnabled: false,
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
      openHomepage: action,
      openRepository: action,
      checkForUpdates: action,
      setAutoCheck: action
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
    recentItems[0].click?.({} as never, {} as never, {} as never)
    expect(input.actions.openRecent).toHaveBeenCalledWith('/a.nii')
  })

  it('adds the macOS application and edit menus', () => {
    const template = createApplicationMenuTemplate(options(true))
    expect(template[0].label).toBe('neoview')
    expect(template.some((item) => item.label === 'Edit')).toBe(true)
  })
})
