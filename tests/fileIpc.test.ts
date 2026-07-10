import { EventEmitter } from 'events'
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { FolderEntry, FolderScan } from '../src/shared/files'
import { FileAccessAuthorizer } from '../src/main/files/access'
import { registerFileIpc, type FileIpcDependencies } from '../src/main/files/ipc'

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
type EventHandler = (event: IpcMainEvent, ...args: unknown[]) => void

class FakeIpc {
  readonly handlers = new Map<string, InvokeHandler>()
  readonly listeners = new Map<string, Set<EventHandler>>()

  handle(channel: string, handler: InvokeHandler): void {
    if (this.handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`)
    this.handlers.set(channel, handler)
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }

  on(channel: string, handler: EventHandler): void {
    const handlers = this.listeners.get(channel) ?? new Set<EventHandler>()
    handlers.add(handler)
    this.listeners.set(channel, handlers)
  }

  removeListener(channel: string, handler: EventHandler): void {
    this.listeners.get(channel)?.delete(handler)
  }

  async invoke(channel: string, sender: FakeSender, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`missing handler: ${channel}`)
    return handler({ sender: sender as unknown as WebContents } as IpcMainInvokeEvent, ...args)
  }

  emit(channel: string, sender: FakeSender, ...args: unknown[]): void {
    for (const handler of this.listeners.get(channel) ?? []) {
      handler({ sender: sender as unknown as WebContents } as IpcMainEvent, ...args)
    }
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0)
  }
}

class FakeSender extends EventEmitter {
  readonly id: number
  readonly sent: Array<{ channel: string; payload: unknown }> = []
  private destroyed = false

  constructor(id: number) {
    super()
    this.id = id
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload })
  }

  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

function file(root: string, name = 'a.nii'): FolderEntry {
  return { name, path: `${root}/${name}`, relDir: '' }
}

function makeDependencies(
  ipc: FakeIpc,
  access: FileAccessAuthorizer,
  overrides: Partial<FileIpcDependencies> = {}
): FileIpcDependencies {
  return {
    ipc: ipc as unknown as FileIpcDependencies['ipc'],
    access,
    dialogs: {
      pickAndRead: async () => null,
      pickScanRoot: async () => '/root',
      pickExportDirectory: async () => '/export'
    },
    reader: {
      read: async (_source, openedPath = _source) => ({
        name: openedPath.split('/').pop() ?? openedPath,
        path: openedPath,
        bytes: new ArrayBuffer(1)
      }),
      readWithin: async (_source, _max, openedPath = _source) => ({
        name: openedPath.split('/').pop() ?? openedPath,
        path: openedPath,
        bytes: new ArrayBuffer(1)
      }),
      readNamed: async (_source, name, openedPath = '') => ({
        name,
        path: openedPath,
        bytes: new ArrayBuffer(1)
      })
    },
    scanner: {
      scan: async (root, onBatch) => {
        const files = [file(root)]
        onBatch?.(files)
        return { root, files, truncated: false }
      }
    },
    exporter: {
      uniquePath: async (dir, name) => `${dir}/${name}`,
      write: async (request) => ({ path: `${request.dir}/${request.fileName}`, sidecarPath: null })
    },
    windowFromSender: () => ({}) as BrowserWindow,
    isDirectory: async () => true,
    revealInFolder: () => {},
    noteFileOpened: () => {},
    ...overrides
  }
}

async function activate(
  access: FileAccessAuthorizer,
  ownerId: number,
  root: string
): Promise<void> {
  const request = access.beginScan(ownerId)
  const prepared = await access.prepareScan(request, root)
  expect(access.activateScan(prepared!)).toBe(true)
}

describe('file IPC registration', () => {
  it('activates access before streaming a batch and isolates another sender', async () => {
    const ipc = new FakeIpc()
    const access = new FileAccessAuthorizer({ realpath: async (path) => path })
    const dispose = registerFileIpc(makeDependencies(ipc, access))
    const owner = new FakeSender(1)
    const other = new FakeSender(2)

    const result = (await ipc.invoke('open-folder-scan', owner, 44)) as FolderScan

    expect(result.root).toBe('/root')
    expect(owner.sent).toEqual([
      {
        channel: 'scan-folder-progress',
        payload: { token: 44, root: '/root', files: [file('/root')] }
      }
    ])
    expect(access.activeRoot(owner.id)).toBe('/root')
    ipc.emit('confirm-folder-scan', owner, 44)
    await expect(ipc.invoke('read-file', owner, '/root/a.nii')).resolves.toMatchObject({
      path: '/root/a.nii'
    })
    await expect(ipc.invoke('read-file', other, '/root/a.nii')).rejects.toThrow('outside')
    ipc.emit('release-folder-access', owner)
    expect(access.activeRoot(owner.id)).toBeNull()
    dispose()
  })

  it('keeps current access when the picker is canceled and clears it on destruction', async () => {
    const ipc = new FakeIpc()
    const access = new FileAccessAuthorizer({ realpath: async (path) => path })
    const sender = new FakeSender(7)
    await activate(access, sender.id, '/old')
    const dispose = registerFileIpc(
      makeDependencies(ipc, access, {
        dialogs: {
          pickAndRead: async () => null,
          pickScanRoot: async () => null,
          pickExportDirectory: async () => null
        }
      })
    )

    await expect(ipc.invoke('open-folder-scan', sender, 1)).resolves.toBeNull()
    expect(access.activeRoot(sender.id)).toBe('/old')

    sender.destroy()
    expect(access.activeRoot(sender.id)).toBeNull()
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
    expect(sender.listenerCount('render-process-gone')).toBe(0)
    dispose()
  })

  it('releases access on a new main-frame document but not same-document or subframe navigation', async () => {
    const ipc = new FakeIpc()
    const access = new FileAccessAuthorizer({ realpath: async (path) => path })
    const dispose = registerFileIpc(makeDependencies(ipc, access))
    const sender = new FakeSender(14)
    await ipc.invoke('scan-folder', sender, '/root', 1)

    sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(access.activeRoot(sender.id)).toBe('/root')
    sender.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(access.activeRoot(sender.id)).toBe('/root')

    sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(access.activeRoot(sender.id)).toBeNull()
    dispose()
  })

  it('releases access when the renderer process disappears', async () => {
    const ipc = new FakeIpc()
    const access = new FileAccessAuthorizer({ realpath: async (path) => path })
    const dispose = registerFileIpc(makeDependencies(ipc, access))
    const sender = new FakeSender(15)
    await ipc.invoke('scan-folder', sender, '/root', 1)

    sender.emit('render-process-gone')

    expect(access.activeRoot(sender.id)).toBeNull()
    dispose()
  })

  it('does not carry access into a different webContents object with the same id', async () => {
    const ipc = new FakeIpc()
    const access = new FileAccessAuthorizer({ realpath: async (path) => path })
    const dispose = registerFileIpc(makeDependencies(ipc, access))
    const original = new FakeSender(12)
    const replacement = new FakeSender(12)
    await ipc.invoke('scan-folder', original, '/root', 1)
    expect(access.activeRoot(12)).toBe('/root')

    await expect(ipc.invoke('read-file', replacement, '/root/a.nii')).rejects.toThrow('outside')
    expect(access.activeRoot(12)).toBeNull()
    dispose()
  })

  it('confirms only the matching scan token and never restores its replaced root', async () => {
    const ipc = new FakeIpc()
    const access = new FileAccessAuthorizer({ realpath: async (path) => path })
    const dispose = registerFileIpc(makeDependencies(ipc, access))
    const sender = new FakeSender(16)
    await activate(access, sender.id, '/old')

    await ipc.invoke('scan-folder', sender, '/candidate', 5)
    expect(access.activeRoot(sender.id)).toBe('/candidate')
    ipc.emit('confirm-folder-scan', sender, 4)
    ipc.emit('cancel-folder-scan', sender, 5)
    expect(access.activeRoot(sender.id)).toBe('/old')

    await ipc.invoke('scan-folder', sender, '/current', 6)
    ipc.emit('confirm-folder-scan', sender, 6)
    ipc.emit('cancel-folder-scan', sender, 6)
    expect(access.activeRoot(sender.id)).toBe('/current')
    dispose()
  })

  it('does not stream or reactivate a scan superseded while it was running', async () => {
    const ipc = new FakeIpc()
    const access = new FileAccessAuthorizer({ realpath: async (path) => path })
    const scans: Array<{
      root: string
      batch: (files: FolderEntry[]) => void
      resolve: (scan: FolderScan) => void
    }> = []
    const scanner: FileIpcDependencies['scanner'] = {
      scan: (root, onBatch) =>
        new Promise<FolderScan>((resolve) => {
          scans.push({ root, batch: (files) => onBatch?.(files), resolve })
        })
    }
    const dispose = registerFileIpc(makeDependencies(ipc, access, { scanner }))
    const sender = new FakeSender(9)

    const first = ipc.invoke('scan-folder', sender, '/first', 1)
    await vi.waitFor(() => expect(scans).toHaveLength(1))
    const second = ipc.invoke('scan-folder', sender, '/second', 2)
    await vi.waitFor(() => expect(scans).toHaveLength(2))

    scans[1].batch([file('/second')])
    expect(access.activeRoot(sender.id)).toBe('/second')
    scans[0].batch([file('/first')])
    expect(sender.sent.map(({ payload }) => payload)).toEqual([
      { token: 2, root: '/second', files: [file('/second')] }
    ])
    expect(access.activeRoot(sender.id)).toBe('/second')

    scans[1].resolve({ root: '/second', files: [file('/second')], truncated: false })
    scans[0].resolve({ root: '/first', files: [file('/first')], truncated: false })
    await expect(second).resolves.toMatchObject({ root: '/second' })
    await expect(first).resolves.toBeNull()
    dispose()
  })

  it('rolls back duplicate registration and disposes handlers, listeners, and access once', async () => {
    const ipc = new FakeIpc()
    const access = new FileAccessAuthorizer({ realpath: async (path) => path })
    const deps = makeDependencies(ipc, access)
    const dispose = registerFileIpc(deps)
    const sender = new FakeSender(3)
    await ipc.invoke('scan-folder', sender, '/root', 1)

    expect(() => registerFileIpc(deps)).toThrow('duplicate handler')
    expect(ipc.handlers.size).toBe(8)
    expect(ipc.listenerCount()).toBe(5)
    expect(access.activeRoot(sender.id)).toBe('/root')
    expect(sender.listenerCount('did-start-navigation')).toBe(1)
    expect(sender.listenerCount('render-process-gone')).toBe(1)

    dispose()
    dispose()
    expect(ipc.handlers.size).toBe(0)
    expect(ipc.listenerCount()).toBe(0)
    expect(access.activeRoot(sender.id)).toBeNull()
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
    expect(sender.listenerCount('render-process-gone')).toBe(0)
    await expect(ipc.invoke('read-file', sender, '/root/a.nii')).rejects.toThrow('missing handler')
  })
})
