import { describe, expect, it } from 'vitest'
import {
  LoadCoordinator,
  type CoordinatorEffects,
  type OpenedBytes,
  type ScanResult
} from '../src/renderer/src/files/loadCoordinator'
import {
  regionExportSource,
  regionExportView,
  type FolderEntry
} from '../src/renderer/src/files/folderList'

// The coordinator exists so that load/scan races are pinned by tests instead
// of being found in review. Each test here simulates one interleaving of
// async operations (reads, parses, scans) with user actions (opens, drops,
// navigation) by resolving hand-held promises in a chosen order, and asserts
// the two invariants: only current generations/sessions publish data, and
// every active feedback group settles once after its final valid operation.

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let every settled promise chain run to its next suspension point. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const bytes = (n = 8): ArrayBuffer => new ArrayBuffer(n)

const entry = (path: string, relDir = ''): FolderEntry => ({
  name: path.split('/').pop() ?? path,
  path,
  relDir
})

const folder = (
  paths: string[],
  root = '/r'
): { root: string; files: FolderEntry[]; truncated: boolean } => ({
  root,
  files: paths.map((p) => entry(p)),
  truncated: false
})

interface Harness {
  co: LoadCoordinator<string>
  state: {
    sourcePath: string | null
    loading: boolean
    scanning: boolean
    folder: { root: string; files: FolderEntry[]; truncated: boolean } | null
  }
  commits: { volume: string; path: string | null }[]
  failures: string[]
  reads: { path: string; d: Deferred<OpenedBytes> }[]
  cappedReads: { path: string; maxBytes: number; d: Deferred<OpenedBytes | null> }[]
  parses: { name: string; d: Deferred<string> }[]
  overlays: { name: string; d: Deferred<void> }[]
  overlayCommits: string[]
  scanConfirms: number[]
  scanCancels: number[]
  setConfirm: (v: boolean) => void
}

/** Effects backed by a miniature store that mirrors the app's semantics:
 * committing a base from outside the open folder closes the folder (which
 * also releases the prefetch slot, as the app's store subscription does).
 * `foldFiles` mirrors the app-side view the snapshot exposes (the app folds
 * region exports out of the list); `deferAutoLoad` is passed through. */
function makeHarness(
  opts: {
    confirm?: boolean
    prefetchMax?: number
    foldFiles?: (files: FolderEntry[]) => FolderEntry[]
    deferAutoLoad?: (entry: FolderEntry) => boolean
  } = {}
): Harness {
  const state: Harness['state'] = {
    sourcePath: null,
    loading: false,
    scanning: false,
    folder: null
  }
  const commits: Harness['commits'] = []
  const failures: string[] = []
  const reads: Harness['reads'] = []
  const cappedReads: Harness['cappedReads'] = []
  const parses: Harness['parses'] = []
  const overlays: Harness['overlays'] = []
  const overlayCommits: string[] = []
  const scanConfirms: number[] = []
  const scanCancels: number[] = []
  let confirmResult = opts.confirm ?? true

  const fx: CoordinatorEffects<string> = {
    snapshot: () => ({
      sourcePath: state.sourcePath,
      loading: state.loading,
      scanning: state.scanning,
      folderRoot: state.folder?.root ?? null,
      folderFiles: state.folder
        ? (opts.foldFiles ?? ((x): FolderEntry[] => x))(state.folder.files)
        : null
    }),
    read: (path) => {
      const d = deferred<OpenedBytes>()
      reads.push({ path, d })
      return d.promise
    },
    readWithin: (path, maxBytes) => {
      const d = deferred<OpenedBytes | null>()
      cappedReads.push({ path, maxBytes, d })
      return d.promise
    },
    parseBase: (name) => {
      const d = deferred<string>()
      parses.push({ name, d })
      return d.promise
    },
    commitBase: (volume, path) => {
      commits.push({ volume, path })
      state.sourcePath = path
      if (state.folder && (path === null || !state.folder.files.some((f) => f.path === path))) {
        state.folder = null
        co.releasePrefetch()
      }
    },
    parseAndAddOverlay: async (name, _bytes, isCurrent) => {
      const basePath = state.sourcePath
      const d = deferred<void>()
      overlays.push({ name, d })
      await d.promise
      if (!isCurrent() || state.sourcePath !== basePath) return
      overlayCommits.push(name)
    },
    confirmReplaceBase: () => confirmResult,
    raiseLoading: () => {
      state.loading = true
    },
    dismissLoading: () => {
      state.loading = false
    },
    failParse: (err) => {
      failures.push(String(err))
      state.loading = false
    },
    failRead: (err) => {
      failures.push(String(err))
      state.loading = false
    },
    setPending: () => {},
    setFolder: (f) => {
      state.folder = f
    },
    appendFolder: (root, files) => {
      if (state.folder && state.folder.root === root) {
        state.folder = { ...state.folder, files: [...state.folder.files, ...files] }
      }
    },
    setScanning: (b) => {
      state.scanning = b
    },
    confirmScan: (token) => scanConfirms.push(token),
    cancelScan: (token) => scanCancels.push(token)
  }
  const co = new LoadCoordinator<string>(fx, {
    prefetchMax: opts.prefetchMax,
    deferAutoLoad: opts.deferAutoLoad
  })
  return {
    co,
    state,
    commits,
    failures,
    reads,
    cappedReads,
    parses,
    overlays,
    overlayCommits,
    scanConfirms,
    scanCancels,
    setConfirm: (v) => {
      confirmResult = v
    }
  }
}

describe('overlay load ownership', () => {
  it('does not let an older overlay settle a newer base loading state', async () => {
    const h = makeHarness()
    void h.co.openOverlay('layer.nii', bytes())
    await tick()
    void h.co.openBase('base.nii', bytes(), '/x/base.nii')
    await tick()

    h.overlays[0].d.resolve()
    await tick()

    expect(h.state.loading).toBe(true)
    h.parses[0].d.resolve('vol:base')
    await tick()
    expect(h.state.loading).toBe(false)
  })

  it('invalidates a slow overlay and still auto-loads a confirmed folder', async () => {
    const h = makeHarness()
    h.state.sourcePath = '/old/base.nii'
    void h.co.openOverlay('layer.nii', bytes())
    await tick()
    const scanDone = deferred<ScanResult | null>()
    let token = 0
    void h.co.scanFolder((value) => {
      token = value
      return scanDone.promise
    })

    h.co.onScanBatch(token, '/new', [entry('/new/first.nii')])
    h.overlays[0].d.resolve()
    await tick()

    expect(h.reads[0]?.path).toBe('/new/first.nii')
    expect(h.overlayCommits).toEqual([])
    scanDone.resolve(folder(['/new/first.nii'], '/new'))
    await tick()
  })

  it('settles loading when a later overlay is discarded after the base commits', async () => {
    const h = makeHarness()
    h.state.sourcePath = '/old/base.nii'
    void h.co.openBase('replacement.nii', bytes(), '/new/replacement.nii')
    await tick()
    void h.co.openOverlay('layer.nii', bytes())
    await tick()

    h.parses[0].d.resolve('vol:replacement')
    await tick()
    expect(h.state.loading).toBe(true)
    h.overlays[0].d.resolve()
    await tick()

    expect(h.overlayCommits).toEqual([])
    expect(h.state.loading).toBe(false)
  })

  it('reports an older same-base overlay failure after a newer layer succeeds', async () => {
    const h = makeHarness()
    h.state.sourcePath = '/base.nii'
    void h.co.openOverlay('older.nii', bytes())
    void h.co.openOverlay('newer.nii', bytes())
    await tick()

    h.overlays[1].d.resolve()
    await tick()
    h.overlays[0].d.reject(new Error('older failed'))
    await tick()

    expect(h.overlayCommits).toEqual(['newer.nii'])
    expect(h.failures).toEqual(['Error: older failed'])
    expect(h.state.loading).toBe(false)
  })

  it('keeps loading for a base after a later overlay succeeds, then reports base failure', async () => {
    const h = makeHarness()
    h.state.sourcePath = '/old/base.nii'
    void h.co.openBase('replacement.nii', bytes(), '/new/replacement.nii')
    await tick()
    void h.co.openOverlay('layer.nii', bytes())
    await tick()

    h.overlays[0].d.resolve()
    await tick()
    expect(h.state.loading).toBe(true)
    h.parses[0].d.reject(new Error('base failed'))
    await tick()

    expect(h.failures).toEqual(['Error: base failed'])
    expect(h.state.loading).toBe(false)
  })
})

describe('base load ownership', () => {
  it('the newest base load owns the view; the older parse discards silently', async () => {
    const h = makeHarness()
    void h.co.openBase('a.nii', bytes(), '/x/a.nii')
    void h.co.openBase('b.nii', bytes(), '/x/b.nii')
    await tick()
    expect(h.parses.map((p) => p.name)).toEqual(['a.nii', 'b.nii'])
    h.parses[0].d.resolve('vol:a')
    await tick()
    expect(h.commits).toEqual([])
    expect(h.state.loading).toBe(true) // the newer load still owns the flag
    h.parses[1].d.resolve('vol:b')
    await tick()
    expect(h.commits).toEqual([{ volume: 'vol:b', path: '/x/b.nii' }])
    expect(h.state.loading).toBe(false)
  })

  it('a superseded parse failure is not reported over the newer load', async () => {
    const h = makeHarness()
    void h.co.openBase('a.nii', bytes(), '/x/a.nii')
    void h.co.openBase('b.nii', bytes(), '/x/b.nii')
    await tick()
    h.parses[0].d.reject(new Error('corrupt'))
    await tick()
    expect(h.failures).toEqual([])
    h.parses[1].d.resolve('vol:b')
    await tick()
    expect(h.commits.map((c) => c.path)).toEqual(['/x/b.nii'])
  })

  it('declining the region confirm cancels the load without touching state', async () => {
    const h = makeHarness({ confirm: false })
    await h.co.openBase('a.nii', bytes(), '/x/a.nii')
    expect(h.parses).toHaveLength(0)
    expect(h.state.loading).toBe(false)
  })
})

describe('coordinator lifecycle', () => {
  it('dispose is repeatable and drops a base result that settles later', async () => {
    const h = makeHarness()
    void h.co.openBase('a.nii', bytes(), '/x/a.nii')
    await tick()
    expect(h.state.loading).toBe(true)

    h.co.dispose()
    h.co.dispose()
    expect(h.state.loading).toBe(false)

    h.parses[0].d.resolve('vol:a')
    await tick()
    expect(h.commits).toEqual([])
    expect(h.failures).toEqual([])
  })

  it('dispose cancels a scan and ignores its final result and late batches', async () => {
    const h = makeHarness()
    const scanDone = deferred<ScanResult | null>()
    let token = 0
    void h.co.scanFolder((value) => {
      token = value
      return scanDone.promise
    })
    expect(h.state.scanning).toBe(true)

    h.co.dispose()
    expect(h.state.scanning).toBe(false)
    expect(h.scanCancels).toEqual([token])
    h.co.onScanBatch(token, '/r', [entry('/r/a.nii')])
    scanDone.resolve(folder(['/r/a.nii']))
    await tick()

    expect(h.state.folder).toBe(null)
    expect(h.reads).toEqual([])
  })

  it('dispose prevents an in-flight prefetch from retaining its bytes', async () => {
    const h = makeHarness()
    h.state.folder = folder(['/r/a.nii', '/r/b.nii'])
    h.state.sourcePath = '/r/a.nii'
    h.co.requestEntry('/r/a.nii')
    await tick()
    expect(h.cappedReads[0]?.path).toBe('/r/b.nii')

    h.co.dispose()
    h.cappedReads[0].d.resolve({ name: 'b.nii', bytes: bytes(32) })
    await tick()
    h.co.requestEntry('/r/b.nii')
    expect(h.reads).toEqual([])
  })

  it('folder release invalidates an in-flight prefetch before the same paths reopen', async () => {
    const h = makeHarness()
    h.state.folder = folder(['/r/a.nii', '/r/b.nii'])
    h.state.sourcePath = '/r/a.nii'
    h.co.requestEntry('/r/a.nii')
    await tick()
    expect(h.cappedReads[0]?.path).toBe('/r/b.nii')

    h.co.releasePrefetch()
    // The next folder session happens to expose the same absolute paths.
    h.state.folder = folder(['/r/a.nii', '/r/b.nii'])
    h.cappedReads[0].d.resolve({ name: 'old-b.nii', bytes: bytes(32) })
    await tick()

    h.co.requestEntry('/r/b.nii')
    expect(h.reads[0]?.path).toBe('/r/b.nii')
    expect(h.parses).toEqual([])
  })

  it('scan confirmation invalidates an in-flight prefetch across a same-root rescan', async () => {
    const h = makeHarness()
    h.state.folder = folder(['/r/a.nii', '/r/b.nii'])
    h.state.sourcePath = '/r/a.nii'
    h.co.requestEntry('/r/a.nii')
    await tick()
    expect(h.cappedReads[0]?.path).toBe('/r/b.nii')

    const scanDone = deferred<ScanResult | null>()
    let token = 0
    void h.co.scanFolder((value) => {
      token = value
      return scanDone.promise
    })
    h.co.onScanBatch(token, '/r', [entry('/r/a.nii'), entry('/r/b.nii')])
    h.cappedReads[0].d.resolve({ name: 'old-b.nii', bytes: bytes(32) })
    scanDone.resolve(folder(['/r/a.nii', '/r/b.nii']))
    await tick()

    h.co.requestEntry('/r/b.nii')
    expect(h.reads[0]?.path).toBe('/r/b.nii')
    expect(h.parses).toEqual([])
  })
})

describe('folder navigation', () => {
  it('holding a key coalesces: bytes read for a superseded target drop unparsed', async () => {
    const h = makeHarness()
    h.state.folder = folder(['/r/a.nii', '/r/b.nii', '/r/c.nii', '/r/d.nii'])
    h.co.requestEntry('/r/b.nii')
    await tick()
    h.co.requestEntry('/r/d.nii') // target moves while b's read is in flight
    h.reads[0].d.resolve({ name: 'b.nii', bytes: bytes() })
    await tick()
    expect(h.parses).toHaveLength(0) // b was never parsed
    expect(h.reads[1]?.path).toBe('/r/d.nii')
    h.reads[1].d.resolve({ name: 'd.nii', bytes: bytes() })
    await tick()
    h.parses[0].d.resolve('vol:d')
    await tick()
    expect(h.commits.map((c) => c.path)).toEqual(['/r/d.nii'])
    expect(h.state.loading).toBe(false)
  })

  it('navigating back to the loaded file discards the middle parse and rests', async () => {
    const h = makeHarness()
    h.state.folder = folder(['/r/a.nii', '/r/b.nii'])
    h.state.sourcePath = '/r/a.nii'
    h.co.requestEntry('/r/b.nii')
    await tick()
    h.reads[0].d.resolve({ name: 'b.nii', bytes: bytes() })
    await tick()
    h.co.requestEntry('/r/a.nii') // back to the already-loaded file mid-parse
    h.parses[0].d.resolve('vol:b')
    await tick()
    expect(h.commits).toEqual([]) // b never flashed
    expect(h.state.loading).toBe(false) // the discard settled its own flag
  })

  it('a corrupt file the user scrubbed past reports nothing and settles', async () => {
    const h = makeHarness()
    h.state.folder = folder(['/r/a.nii', '/r/b.nii', '/r/c.nii'])
    h.co.requestEntry('/r/b.nii')
    await tick()
    h.reads[0].d.resolve({ name: 'b.nii', bytes: bytes() })
    await tick()
    h.co.requestEntry('/r/c.nii') // moved on while b parses
    h.parses[0].d.reject(new Error('corrupt'))
    await tick()
    expect(h.failures).toEqual([]) // nobody is waiting on b
    expect(h.reads[1]?.path).toBe('/r/c.nii') // the pump chased the new target
    h.reads[1].d.resolve({ name: 'c.nii', bytes: bytes() })
    await tick()
    h.parses[1].d.resolve('vol:c')
    await tick()
    expect(h.commits.map((c) => c.path)).toEqual(['/r/c.nii'])
  })

  it('same-root scan confirmation cannot reuse an old in-flight read of the same path', async () => {
    const h = makeHarness()
    h.state.folder = folder(['/r/a.nii'])
    h.co.requestEntry('/r/a.nii')
    expect(h.reads[0]?.path).toBe('/r/a.nii')

    const scanDone = deferred<ScanResult | null>()
    let token = 0
    void h.co.scanFolder((value) => {
      token = value
      return scanDone.promise
    })
    h.co.onScanBatch(token, '/r', [entry('/r/a.nii')])
    h.reads[0].d.resolve({ name: 'old-a.nii', bytes: bytes() })
    await tick()

    expect(h.parses).toEqual([])
    expect(h.reads[1]?.path).toBe('/r/a.nii')
    h.reads[1].d.resolve({ name: 'new-a.nii', bytes: bytes() })
    await tick()
    h.parses[0].d.resolve('vol:new')
    scanDone.resolve(folder(['/r/a.nii']))
    await tick()
    expect(h.commits).toEqual([{ volume: 'vol:new', path: '/r/a.nii' }])
  })

  it('same-root scan confirmation suppresses an old read failure and retries the path', async () => {
    const h = makeHarness()
    h.state.folder = folder(['/r/a.nii'])
    h.co.requestEntry('/r/a.nii')
    const scanDone = deferred<ScanResult | null>()
    let token = 0
    void h.co.scanFolder((value) => {
      token = value
      return scanDone.promise
    })
    h.co.onScanBatch(token, '/r', [entry('/r/a.nii')])
    h.reads[0].d.reject(new Error('old failure'))
    await tick()

    expect(h.failures).toEqual([])
    expect(h.reads[1]?.path).toBe('/r/a.nii')
    h.reads[1].d.resolve({ name: 'new-a.nii', bytes: bytes() })
    await tick()
    h.parses[0].d.resolve('vol:new')
    scanDone.resolve(folder(['/r/a.nii']))
    await tick()
    expect(h.commits).toEqual([{ volume: 'vol:new', path: '/r/a.nii' }])
  })

  it('a failed folder read reports the error and stops the pump', async () => {
    const h = makeHarness()
    h.state.folder = folder(['/r/a.nii'])
    h.co.requestEntry('/r/a.nii')
    await tick()
    h.reads[0].d.reject(new Error('io'))
    await tick()
    expect(h.failures).toHaveLength(1)
    expect(h.state.loading).toBe(false)
  })

  it('a read that fails after the target moved is suppressed; the pump chases on', async () => {
    const h = makeHarness()
    h.state.folder = folder(['/r/a.nii', '/r/b.nii', '/r/c.nii'])
    h.co.requestEntry('/r/b.nii')
    await tick()
    h.co.requestEntry('/r/c.nii') // moved on while b's read is in flight
    h.reads[0].d.reject(new Error('unreadable'))
    await tick()
    expect(h.failures).toEqual([]) // nobody is waiting on b
    expect(h.reads[1]?.path).toBe('/r/c.nii') // c still loads
    h.reads[1].d.resolve({ name: 'c.nii', bytes: bytes() })
    await tick()
    h.parses[0].d.resolve('vol:c')
    await tick()
    expect(h.commits.map((c) => c.path)).toEqual(['/r/c.nii'])
  })

  it('a read that fails after an explicit open started stands down silently', async () => {
    const h = makeHarness()
    h.state.folder = folder(['/r/a.nii', '/r/b.nii'])
    h.co.requestEntry('/r/b.nii')
    await tick()
    void h.co.openBase('x.nii', bytes(), '/x/x.nii') // user acts mid-read
    await tick()
    h.reads[0].d.reject(new Error('unreadable'))
    await tick()
    expect(h.failures).toEqual([]) // the stale read's error is not the view's problem
    h.parses[0].d.resolve('vol:x')
    await tick()
    expect(h.commits.map((c) => c.path)).toEqual(['/x/x.nii'])
  })

  it('an explicit open already parsing wins over navigation, even on a prefetch hit', async () => {
    const h = makeHarness()
    h.state.folder = folder(['/r/a.nii', '/r/b.nii'])
    h.state.sourcePath = '/r/a.nii'
    // Fill the prefetch slot for b.
    h.co.requestEntry('/r/a.nii')
    await tick()
    expect(h.cappedReads[0]?.path).toBe('/r/b.nii')
    h.cappedReads[0].d.resolve({ name: 'b.nii', bytes: bytes() })
    await tick()
    // Explicit open starts parsing; then the user presses the arrow key.
    void h.co.openBase('x.nii', bytes(), '/elsewhere/x.nii')
    await tick()
    h.co.navigate(1)
    await tick()
    expect(h.parses.map((p) => p.name)).toEqual(['x.nii']) // cached b never parsed
    h.parses[0].d.resolve('vol:x')
    await tick()
    expect(h.commits.map((c) => c.path)).toEqual(['/elsewhere/x.nii'])
  })
})

describe('prefetch', () => {
  it('reads through the size-gated channel and skips oversized neighbors', async () => {
    const h = makeHarness({ prefetchMax: 1000 })
    h.state.folder = folder(['/r/a.nii', '/r/b.nii'])
    h.state.sourcePath = '/r/a.nii'
    h.co.requestEntry('/r/a.nii') // settles instantly; schedules the prefetch
    await tick()
    expect(h.reads).toHaveLength(0) // never the uncapped channel
    expect(h.cappedReads[0]).toMatchObject({ path: '/r/b.nii', maxBytes: 1000 })
    h.cappedReads[0].d.resolve(null) // over the cap: no bytes ever crossed
    await tick()
    h.co.requestEntry('/r/b.nii')
    await tick()
    expect(h.reads[0]?.path).toBe('/r/b.nii') // nothing cached — real read
  })

  it('a prefetch hit skips the read entirely', async () => {
    const h = makeHarness()
    h.state.folder = folder(['/r/a.nii', '/r/b.nii'])
    h.state.sourcePath = '/r/a.nii'
    h.co.requestEntry('/r/a.nii')
    await tick()
    h.cappedReads[0].d.resolve({ name: 'b.nii', bytes: bytes() })
    await tick()
    h.co.requestEntry('/r/b.nii')
    await tick()
    expect(h.reads).toHaveLength(0) // served from the slot
    h.parses[0].d.resolve('vol:b')
    await tick()
    expect(h.commits.map((c) => c.path)).toEqual(['/r/b.nii'])
  })
})

describe('folder scans', () => {
  it('cancels the main-side request when a scan rejects', async () => {
    const h = makeHarness()

    await expect(
      h.co.scanFolder(async () => {
        throw new Error('scan failed')
      })
    ).rejects.toThrow('scan failed')

    expect(h.scanCancels).toEqual([1])
    expect(h.state.scanning).toBe(false)
  })

  it('a confirmed scan invalidates an in-flight base parse exactly once', async () => {
    const h = makeHarness()
    void h.co.openBase('slow.nii', bytes(), '/old/slow.nii')
    await tick()
    expect(h.state.loading).toBe(true)
    let token = 0
    const scanDone = deferred<ScanResult | null>()
    const scanP = h.co.scanFolder((t) => {
      token = t
      return scanDone.promise
    })
    // The first streamed batch confirms the scan: the parse is invalidated
    // and its ownerless loading flag settles now.
    h.co.onScanBatch(token, '/new', [entry('/new/a.nii')])
    expect(h.state.loading).toBe(false)
    expect(h.state.folder?.root).toBe('/new')
    expect(h.reads[0]?.path).toBe('/new/a.nii') // auto-load kicked off
    // The invalidated parse resolves: it must neither publish nor clear the
    // new folder as an "outside" load.
    h.parses[0].d.resolve('vol:slow')
    await tick()
    expect(h.commits).toEqual([])
    expect(h.state.folder?.root).toBe('/new')
    h.reads[0].d.resolve({ name: 'a.nii', bytes: bytes() })
    await tick()
    h.parses[1].d.resolve('vol:a')
    await tick()
    expect(h.commits.map((c) => c.path)).toEqual(['/new/a.nii'])
    scanDone.resolve({ root: '/new', files: [entry('/new/a.nii')], truncated: false })
    await expect(scanP).resolves.toBe(true)
    expect(h.state.folder?.files.map((f) => f.path)).toEqual(['/new/a.nii'])
  })

  it('opening the folder picker and canceling leaves an in-flight parse alone', async () => {
    const h = makeHarness()
    void h.co.openBase('a.nii', bytes(), '/x/a.nii')
    await tick()
    await expect(h.co.scanFolder(() => Promise.resolve(null))).resolves.toBe(false)
    expect(h.state.loading).toBe(true) // untouched by the canceled picker
    h.parses[0].d.resolve('vol:a')
    await tick()
    expect(h.commits.map((c) => c.path)).toEqual(['/x/a.nii'])
  })

  it('a scan that finds nothing still settles a superseded parse', async () => {
    const h = makeHarness()
    let token = 0
    void h.co.openBase('slow.nii', bytes(), '/old/slow.nii')
    await tick()
    await expect(
      h.co.scanFolder((value) => {
        token = value
        return Promise.resolve({ root: '/empty', files: [], truncated: false })
      })
    ).resolves.toBe(true)
    expect(h.scanConfirms).toEqual([token])
    expect(h.state.loading).toBe(false) // settled at final-result confirmation
    expect(h.state.folder?.root).toBe('/empty')
    h.parses[0].d.resolve('vol:slow')
    await tick()
    expect(h.commits).toEqual([])
    expect(h.state.folder?.root).toBe('/empty') // not cleared by the stale parse
  })

  it('declining the replace confirm leaves a running scan untouched', async () => {
    const h = makeHarness()
    let token = 0
    const scanDone = deferred<ScanResult | null>()
    void h.co.scanFolder((t) => {
      token = t
      return scanDone.promise
    })
    expect(h.state.scanning).toBe(true)
    h.setConfirm(false)
    await h.co.openBase('x.nii', bytes(), '/x/x.nii') // user cancels the prompt
    expect(h.state.scanning).toBe(true) // the scan was NOT abandoned
    expect(h.parses).toHaveLength(0)
    h.setConfirm(true)
    h.co.onScanBatch(token, '/scan', [entry('/scan/a.nii')]) // batches still land
    expect(h.state.folder?.root).toBe('/scan')
    scanDone.resolve({ root: '/scan', files: [entry('/scan/a.nii')], truncated: false })
    await tick()
    expect(h.state.scanning).toBe(false)
    expect(h.state.folder?.files.map((f) => f.path)).toEqual(['/scan/a.nii'])
  })

  it('an explicit open abandons the running scan; its late batches are ignored', async () => {
    const h = makeHarness()
    let token = 0
    const scanDone = deferred<ScanResult | null>()
    const scanP = h.co.scanFolder((t) => {
      token = t
      return scanDone.promise
    })
    expect(h.state.scanning).toBe(true)
    void h.co.openBase('x.nii', bytes(), '/x/x.nii')
    await tick()
    expect(h.state.scanning).toBe(false) // abandoned by the explicit open
    expect(h.scanCancels).toEqual([token])
    h.co.onScanBatch(token, '/scan', [entry('/scan/a.nii')])
    expect(h.state.folder).toBeNull() // stale batch changed nothing
    h.parses[0].d.resolve('vol:x')
    await tick()
    expect(h.commits.map((c) => c.path)).toEqual(['/x/x.nii'])
    scanDone.resolve({ root: '/scan', files: [entry('/scan/a.nii')], truncated: false })
    await expect(scanP).resolves.toBe(true) // handled — but changed nothing
    expect(h.state.folder).toBeNull()
  })

  it('accepting a batch confirms its token before an abandon cancels it', () => {
    const h = makeHarness()
    let token = 0
    void h.co.scanFolder((value) => {
      token = value
      return new Promise<ScanResult | null>(() => {})
    })
    h.co.onScanBatch(token, '/scan', [entry('/scan/a.nii')])

    h.co.abandonScan()

    expect(h.scanConfirms).toEqual([token])
    expect(h.scanCancels).toEqual([token])
  })

  it('starting a newer scan cancels an unconfirmed main-side candidate first', () => {
    const h = makeHarness()
    let firstToken = 0
    void h.co.scanFolder((token) => {
      firstToken = token
      return new Promise<ScanResult | null>(() => {})
    })

    void h.co.scanFolder(() => new Promise<ScanResult | null>(() => {}))

    expect(h.scanCancels).toEqual([firstToken])
  })

  it('a source under the scanned root defers replacement to the final result', async () => {
    const h = makeHarness()
    h.state.sourcePath = '/root/sub/current.nii'
    let token = 0
    const scanDone = deferred<ScanResult | null>()
    void h.co.scanFolder((t) => {
      token = t
      return scanDone.promise
    })
    h.co.onScanBatch(token, '/root', [entry('/root/a.nii')])
    expect(h.reads).toHaveLength(0) // the current file may still stream in
    scanDone.resolve({ root: '/root', files: [entry('/root/a.nii')], truncated: false })
    await tick()
    expect(h.reads[0]?.path).toBe('/root/a.nii') // the final list settles it
  })

  // The tests below wire the harness the way the app wires the real
  // coordinator: the snapshot folds region exports out of the list and
  // deferAutoLoad flags product names, so the interleavings around products
  // streaming in before their sources are pinned end to end.
  const foldOpts = {
    foldFiles: (files: FolderEntry[]): FolderEntry[] => regionExportView(files).files,
    deferAutoLoad: (f: FolderEntry): boolean => regionExportSource(f.name) !== null
  }

  it('a product streamed before its source is not auto-loaded from a batch', async () => {
    const h = makeHarness(foldOpts)
    let token = 0
    const scanDone = deferred<ScanResult | null>()
    void h.co.scanFolder((t) => {
      token = t
      return scanDone.promise
    })
    // The filesystem happens to surface the export before its source volume.
    h.co.onScanBatch(token, '/r', [entry('/r/a.regions.nii.gz')])
    expect(h.reads).toHaveLength(0) // stays armed instead of loading the product
    h.co.onScanBatch(token, '/r', [entry('/r/a.nii.gz')])
    expect(h.reads[0]?.path).toBe('/r/a.nii.gz') // the source loads; the product folded away
    scanDone.resolve({
      root: '/r',
      files: [entry('/r/a.nii.gz'), entry('/r/a.regions.nii.gz')],
      truncated: false
    })
    await tick()
    expect(h.reads).toHaveLength(1) // the final result triggers no second load
  })

  it('a product with no source in the folder loads only from the final result', async () => {
    const h = makeHarness(foldOpts)
    let token = 0
    const scanDone = deferred<ScanResult | null>()
    void h.co.scanFolder((t) => {
      token = t
      return scanDone.promise
    })
    h.co.onScanBatch(token, '/r', [entry('/r/b.mask.nii.gz')])
    expect(h.reads).toHaveLength(0) // its source may still stream in
    scanDone.resolve({ root: '/r', files: [entry('/r/b.mask.nii.gz')], truncated: false })
    await tick()
    // With the whole folder known it is a plain entry after all — load it.
    expect(h.reads[0]?.path).toBe('/r/b.mask.nii.gz')
  })

  it('an ambiguous head entry is never skipped for a later plain entry', async () => {
    const h = makeHarness(foldOpts)
    let token = 0
    const scanDone = deferred<ScanResult | null>()
    void h.co.scanFolder((t) => {
      token = t
      return scanDone.promise
    })
    h.co.onScanBatch(token, '/r', [entry('/r/a.mask.nii.gz')])
    h.co.onScanBatch(token, '/r', [entry('/r/b.nii.gz')])
    // The head may still fold away (its source may stream in) or survive as
    // the folder's true first file — neither justifies loading b early.
    expect(h.reads).toHaveLength(0)
    scanDone.resolve({
      root: '/r',
      files: [entry('/r/a.mask.nii.gz'), entry('/r/b.nii.gz')],
      truncated: false
    })
    await tick()
    // No source ever arrived: the product IS the folder's first file.
    expect(h.reads.map((r) => r.path)).toEqual(['/r/a.mask.nii.gz'])
  })

  it('a pick on the old list before the scan confirms does not eat the new folder auto-load', async () => {
    const h = makeHarness()
    h.state.folder = folder(['/old/a.nii', '/old/b.nii'], '/old')
    h.state.sourcePath = '/old/a.nii'
    let token = 0
    const scanDone = deferred<ScanResult | null>()
    void h.co.scanFolder((t) => {
      token = t
      return scanDone.promise
    })
    // No batch has arrived yet, so the OLD folder's list is still shown and
    // interactive — the user clicks a row in it.
    h.co.requestEntry('/old/b.nii')
    expect(h.reads[0]?.path).toBe('/old/b.nii')
    // The new folder's first batch confirms the scan: the old pick is
    // invalidated, and the auto-load — which that pick must NOT have
    // disarmed — targets the new folder's first file.
    h.co.onScanBatch(token, '/new', [entry('/new/x.nii')])
    expect(h.state.folder?.root).toBe('/new')
    h.reads[0].d.resolve({ name: 'b.nii', bytes: bytes() })
    await tick()
    expect(h.parses).toHaveLength(0) // the stale pick's bytes drop unparsed
    expect(h.reads[1]?.path).toBe('/new/x.nii')
    h.reads[1].d.resolve({ name: 'x.nii', bytes: bytes() })
    await tick()
    h.parses[0].d.resolve('vol:x')
    await tick()
    expect(h.commits.map((c) => c.path)).toEqual(['/new/x.nii'])
    scanDone.resolve({ root: '/new', files: [entry('/new/x.nii')], truncated: false })
    await tick()
    expect(h.commits.map((c) => c.path)).toEqual(['/new/x.nii']) // final adds nothing
  })

  it('a pick made while the auto-load waits disarms it instead of being overridden', async () => {
    const h = makeHarness(foldOpts)
    let token = 0
    const scanDone = deferred<ScanResult | null>()
    void h.co.scanFolder((t) => {
      token = t
      return scanDone.promise
    })
    // Ambiguous head (sorts first) keeps the auto-load armed and waiting...
    h.co.onScanBatch(token, '/r', [
      entry('/r/a.mask.nii.gz'),
      entry('/r/m.nii.gz'),
      entry('/r/n.nii.gz')
    ])
    expect(h.reads).toHaveLength(0)
    // ...and the user picks a file while it waits.
    h.co.requestEntry('/r/n.nii.gz')
    expect(h.reads.map((r) => r.path)).toEqual(['/r/n.nii.gz'])
    // The head's source streams in: the head folds away and a plain entry
    // now tops the list — but the user's pick already claimed the view, so
    // the auto-load must not fire over it.
    h.co.onScanBatch(token, '/r', [entry('/r/a.nii.gz')])
    expect(h.reads).toHaveLength(1)
    h.reads[0].d.resolve({ name: 'n.nii.gz', bytes: bytes() })
    await tick()
    h.parses[0].d.resolve('vol:n')
    await tick()
    expect(h.commits.map((c) => c.path)).toEqual(['/r/n.nii.gz'])
    scanDone.resolve({
      root: '/r',
      files: [
        entry('/r/a.mask.nii.gz'),
        entry('/r/a.nii.gz'),
        entry('/r/m.nii.gz'),
        entry('/r/n.nii.gz')
      ],
      truncated: false
    })
    await tick()
    // The final result respects the pick too (the loaded file is in the list).
    expect(h.commits.map((c) => c.path)).toEqual(['/r/n.nii.gz'])
    expect(h.reads).toHaveLength(1)
  })

  it('re-scanning the same root starts a fresh list instead of merging stale entries', async () => {
    const h = makeHarness()
    h.state.folder = folder(['/r/gone.nii', '/r/kept.nii'])
    h.state.sourcePath = '/r/kept.nii'
    let token = 0
    const scanDone = deferred<ScanResult | null>()
    void h.co.scanFolder((t) => {
      token = t
      return scanDone.promise
    })
    h.co.onScanBatch(token, '/r', [entry('/r/kept.nii')])
    expect(h.state.folder?.files.map((f) => f.path)).toEqual(['/r/kept.nii'])
    h.co.onScanBatch(token, '/r', [entry('/r/new.nii')]) // later batches append
    expect(h.state.folder?.files.map((f) => f.path)).toEqual(['/r/kept.nii', '/r/new.nii'])
    scanDone.resolve({
      root: '/r',
      files: [entry('/r/kept.nii'), entry('/r/new.nii')],
      truncated: false
    })
    await tick()
    expect(h.state.folder?.files.map((f) => f.path)).toEqual(['/r/kept.nii', '/r/new.nii'])
  })
})
