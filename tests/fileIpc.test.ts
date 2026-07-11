import { EventEmitter } from 'events'
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { FolderEntry, FolderScan } from '../src/shared/files'
import { FileAccessAuthorizer } from '../src/main/files/access'
import { registerFileIpc, type FileIpcDependencies } from '../src/main/files/ipc'
import { OpenJobCoordinator } from '../src/main/openJobs'
import { createRendererMainFrameGate } from '../src/main/rendererProtocol'

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
type EventHandler = (event: IpcMainEvent, ...args: unknown[]) => void

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

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
    return this.invokeFrom(channel, sender, sender.mainFrame, ...args)
  }

  async invokeFrom(
    channel: string,
    sender: FakeSender,
    senderFrame: object,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`missing handler: ${channel}`)
    return handler(
      { sender: sender as unknown as WebContents, senderFrame } as IpcMainInvokeEvent,
      ...args
    )
  }

  emit(channel: string, sender: FakeSender, ...args: unknown[]): void {
    this.emitFrom(channel, sender, sender.mainFrame, ...args)
  }

  emitFrom(channel: string, sender: FakeSender, senderFrame: object, ...args: unknown[]): void {
    for (const handler of this.listeners.get(channel) ?? []) {
      handler({ sender: sender as unknown as WebContents, senderFrame } as IpcMainEvent, ...args)
    }
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0)
  }
}

class FakeSender extends EventEmitter {
  readonly id: number
  readonly sent: Array<{ channel: string; payload: unknown }> = []
  mainFrame: { url: string } = { url: 'app://renderer/index.html' }
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
      pickFilePath: async () => null,
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
      write: async (request) => ({ path: `${request.dir}/${request.fileName}`, sidecarPath: null })
    },
    openJobs: new OpenJobCoordinator<WebContents>(),
    isTrustedMainFrame: createRendererMainFrameGate(null),
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
  expect(access.confirmScan(prepared!)).toBe(true)
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
    await expect(ipc.invoke('read-file', owner, '/root/a.nii', 1)).resolves.toMatchObject({
      path: '/root/a.nii'
    })
    await expect(ipc.invoke('read-file', other, '/root/a.nii', 1)).rejects.toThrow('outside')
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
          pickFilePath: async () => null,
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
    expect(sender.listenerCount('did-navigate')).toBe(0)
    expect(sender.listenerCount('render-process-gone')).toBe(0)
    dispose()
  })

  it('keeps access through failed navigation and releases it only after a new document commits', async () => {
    const ipc = new FakeIpc()
    const access = new FileAccessAuthorizer({ realpath: async (path) => path })
    const dispose = registerFileIpc(makeDependencies(ipc, access))
    const sender = new FakeSender(14)
    await ipc.invoke('scan-folder', sender, '/root', 1)

    sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(access.activeRoot(sender.id)).toBe('/root')
    sender.emit('will-redirect', { url: 'https://remote.test/' })
    expect(access.activeRoot(sender.id)).toBe('/root')
    sender.emit('did-fail-load', { isMainFrame: true })
    expect(access.activeRoot(sender.id)).toBe('/root')

    sender.emit('did-navigate')
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

  it('rejects a remote document even when it is the current main frame', async () => {
    const ipc = new FakeIpc()
    const access = new FileAccessAuthorizer({ realpath: async (path) => path })
    const write = vi.fn(async () => ({ path: '/export/item.nii', sidecarPath: null }))
    const reveal = vi.fn()
    const note = vi.fn()
    const dispose = registerFileIpc(
      makeDependencies(ipc, access, {
        exporter: { write },
        revealInFolder: reveal,
        noteFileOpened: note
      })
    )
    const sender = new FakeSender(17)
    sender.mainFrame = { url: 'https://remote.test/' }

    await expect(ipc.invoke('export-file', sender, {})).rejects.toThrow(
      'File operation is unavailable.'
    )
    ipc.emit('reveal-in-folder', sender, '/export/item.nii')
    ipc.emit('note-file-opened', sender, '/export/item.nii')

    expect(write).not.toHaveBeenCalled()
    expect(reveal).not.toHaveBeenCalled()
    expect(note).not.toHaveBeenCalled()
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

    await expect(ipc.invoke('read-file', replacement, '/root/a.nii', 1)).rejects.toThrow('outside')
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

  it('rolls back an activated candidate when a streamed scan fails', async () => {
    const ipc = new FakeIpc()
    const access = new FileAccessAuthorizer({ realpath: async (path) => path })
    const sender = new FakeSender(18)
    await activate(access, sender.id, '/old')
    const dispose = registerFileIpc(
      makeDependencies(ipc, access, {
        scanner: {
          scan: async (root, onBatch) => {
            onBatch?.([file(root)])
            throw new Error('scan failed')
          }
        }
      })
    )

    await expect(ipc.invoke('scan-folder', sender, '/candidate', 8)).rejects.toThrow('scan failed')
    expect(access.activeRoot(sender.id)).toBe('/old')
    ipc.emit('confirm-folder-scan', sender, 8)
    expect(access.activeRoot(sender.id)).toBe('/old')
    dispose()
  })

  it('cancels only the owned read request and aborts remaining reads on sender loss', async () => {
    const ipc = new FakeIpc()
    const access = new FileAccessAuthorizer({ realpath: async (path) => path })
    const operations: Array<{
      path: string
      signal: AbortSignal
      result: Deferred<{ name: string; path: string; bytes: ArrayBuffer }>
    }> = []
    const read: FileIpcDependencies['reader']['read'] = async (
      _source,
      openedPath = _source,
      signal
    ) => {
      const result = deferred<{ name: string; path: string; bytes: ArrayBuffer }>()
      const ownedSignal = signal ?? new AbortController().signal
      const onAbort = (): void => result.reject(ownedSignal.reason)
      if (ownedSignal.aborted) onAbort()
      else ownedSignal.addEventListener('abort', onAbort, { once: true })
      operations.push({ path: openedPath, signal: ownedSignal, result })
      return result.promise.finally(() => ownedSignal.removeEventListener('abort', onAbort))
    }
    const dispose = registerFileIpc(
      makeDependencies(ipc, access, {
        reader: {
          read,
          readWithin: async () => null,
          readNamed: async (_source, name, openedPath = '') => ({
            name,
            path: openedPath,
            bytes: new ArrayBuffer(1)
          })
        }
      })
    )
    const sender = new FakeSender(21)
    await activate(access, sender.id, '/root')

    const first = ipc.invoke('read-file', sender, '/root/a.nii', 101)
    const second = ipc.invoke('read-file', sender, '/root/b.nii', 102)
    await vi.waitFor(() => expect(operations).toHaveLength(2))
    ipc.emit('cancel-file-read', sender, 101)

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(operations.map(({ path }) => path)).toEqual(['/root/a.nii', '/root/b.nii'])
    expect(operations.map(({ signal }) => signal.aborted)).toEqual([true, false])
    operations[1].result.resolve({
      name: 'b.nii',
      path: '/root/b.nii',
      bytes: new ArrayBuffer(1)
    })
    await expect(second).resolves.toMatchObject({ path: '/root/b.nii' })

    const third = ipc.invoke('read-file', sender, '/root/c.nii', 103)
    await vi.waitFor(() => expect(operations).toHaveLength(3))
    sender.destroy()
    await expect(third).rejects.toMatchObject({ name: 'AbortError' })
    expect(operations[2].signal.aborted).toBe(true)
    dispose()
  })

  it('passes cancellation ownership through the size-limited read channel', async () => {
    const ipc = new FakeIpc()
    const access = new FileAccessAuthorizer({ realpath: async (path) => path })
    let signal: AbortSignal | undefined
    const pending = deferred<never>()
    const dispose = registerFileIpc(
      makeDependencies(ipc, access, {
        reader: {
          read: async () => ({ name: 'a.nii', path: '/root/a.nii', bytes: new ArrayBuffer(1) }),
          readWithin: async (_source, _maxBytes, _openedPath, ownedSignal) => {
            signal = ownedSignal
            const onAbort = (): void => pending.reject(ownedSignal?.reason)
            ownedSignal?.addEventListener('abort', onAbort, { once: true })
            return pending.promise.finally(() => ownedSignal?.removeEventListener('abort', onAbort))
          },
          readNamed: async (_source, name, openedPath = '') => ({
            name,
            path: openedPath,
            bytes: new ArrayBuffer(1)
          })
        }
      })
    )
    const sender = new FakeSender(22)
    await activate(access, sender.id, '/root')

    const read = ipc.invoke('read-file-limited', sender, '/root/a.nii', 1024, 201)
    await vi.waitFor(() => expect(signal).toBeDefined())
    ipc.emit('cancel-file-read', sender, 201)

    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
    expect(signal?.aborted).toBe(true)
    dispose()
  })

  it('cancels an overlay picker/read when its renderer owner releases the request', async () => {
    const ipc = new FakeIpc()
    const access = new FileAccessAuthorizer({ realpath: async (path) => path })
    let signal: AbortSignal | undefined
    const pending = deferred<never>()
    const dispose = registerFileIpc(
      makeDependencies(ipc, access, {
        dialogs: {
          pickFilePath: async () => null,
          pickAndRead: async (_window, ownedSignal) => {
            signal = ownedSignal
            const onAbort = (): void => pending.reject(ownedSignal?.reason)
            ownedSignal?.addEventListener('abort', onAbort, { once: true })
            return pending.promise.finally(() => ownedSignal?.removeEventListener('abort', onAbort))
          },
          pickScanRoot: async () => null,
          pickExportDirectory: async () => null
        }
      })
    )
    const sender = new FakeSender(25)

    const opening = ipc.invoke('open-overlay-dialog', sender, 301)
    await vi.waitFor(() => expect(signal).toBeDefined())
    ipc.emit('cancel-file-read', sender, 301)

    await expect(opening).resolves.toBeNull()
    expect(signal?.aborted).toBe(true)
    dispose()
  })

  it('rejects stale document cancel and release messages after request-id reuse', async () => {
    const ipc = new FakeIpc()
    const access = new FileAccessAuthorizer({ realpath: async (path) => path })
    let signal: AbortSignal | undefined
    const pending = deferred<{ name: string; path: string; bytes: ArrayBuffer }>()
    const dispose = registerFileIpc(
      makeDependencies(ipc, access, {
        reader: {
          read: async (_source, _openedPath = _source, ownedSignal) => {
            void _openedPath
            signal = ownedSignal
            const onAbort = (): void => pending.reject(ownedSignal?.reason)
            ownedSignal?.addEventListener('abort', onAbort, { once: true })
            return pending.promise.finally(() => ownedSignal?.removeEventListener('abort', onAbort))
          },
          readWithin: async () => null,
          readNamed: async (_source, name, openedPath = '') => ({
            name,
            path: openedPath,
            bytes: new ArrayBuffer(1)
          })
        }
      })
    )
    const sender = new FakeSender(23)
    const oldFrame = sender.mainFrame
    await ipc.invoke('scan-folder', sender, '/old', 1)
    ipc.emit('confirm-folder-scan', sender, 1)

    sender.emit('did-navigate')
    sender.mainFrame = { url: 'app://renderer/reloaded.html' }
    await ipc.invoke('scan-folder', sender, '/new', 2)
    ipc.emit('confirm-folder-scan', sender, 2)
    const read = ipc.invoke('read-file', sender, '/new/a.nii', 1)
    await vi.waitFor(() => expect(signal).toBeDefined())

    ipc.emitFrom('cancel-file-read', sender, oldFrame, 1)
    ipc.emitFrom('release-folder-access', sender, oldFrame)
    expect(signal?.aborted).toBe(false)
    expect(access.activeRoot(sender.id)).toBe('/new')

    ipc.emit('cancel-file-read', sender, 1)
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
    dispose()
  })

  it('drops a picked base file when its originating document navigated', async () => {
    const ipc = new FakeIpc()
    const access = new FileAccessAuthorizer({ realpath: async (path) => path })
    const picked = deferred<string | null>()
    const read = vi.fn(async () => ({
      name: 'a.nii',
      path: '/root/a.nii',
      bytes: new ArrayBuffer(1)
    }))
    const openJobs = new OpenJobCoordinator<WebContents>()
    const dispose = registerFileIpc(
      makeDependencies(ipc, access, {
        openJobs,
        dialogs: {
          pickFilePath: () => picked.promise,
          pickAndRead: async () => null,
          pickScanRoot: async () => null,
          pickExportDirectory: async () => null
        },
        reader: {
          read,
          readWithin: async () => null,
          readNamed: async (_source, name, openedPath = '') => ({
            name,
            path: openedPath,
            bytes: new ArrayBuffer(1)
          })
        }
      })
    )
    const sender = new FakeSender(24)
    const opening = ipc.invoke('open-dialog', sender, 1)
    await Promise.resolve()
    openJobs.invalidateOwner(sender as unknown as WebContents)
    sender.mainFrame = { url: 'app://renderer/reloaded.html' }
    picked.resolve('/root/a.nii')

    await expect(opening).resolves.toBeNull()
    expect(read).not.toHaveBeenCalled()
    expect(openJobs.current()).toBe(0)
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
    expect(ipc.handlers.size).toBe(9)
    expect(ipc.listenerCount()).toBe(6)
    expect(access.activeRoot(sender.id)).toBe('/root')
    expect(sender.listenerCount('did-navigate')).toBe(1)
    expect(sender.listenerCount('render-process-gone')).toBe(1)

    dispose()
    dispose()
    expect(ipc.handlers.size).toBe(0)
    expect(ipc.listenerCount()).toBe(0)
    expect(access.activeRoot(sender.id)).toBeNull()
    expect(sender.listenerCount('did-navigate')).toBe(0)
    expect(sender.listenerCount('render-process-gone')).toBe(0)
    await expect(ipc.invoke('read-file', sender, '/root/a.nii', 1)).rejects.toThrow(
      'missing handler'
    )
  })
})
