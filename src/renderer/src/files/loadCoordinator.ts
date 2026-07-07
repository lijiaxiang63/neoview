import { adjacentIndex, isUnderRoot, sortEntries, type FolderEntry } from './folderList'

// All load/scan orchestration lives in this one pure module so its
// interleavings are unit-testable (tests/loadCoordinator.test.ts): every
// async operation (read, parse, scan) crossed with every user entry point
// (explicit open, drop, folder navigation, folder open) is a potential race,
// and the guards below are exactly the invariants those tests pin down.
//
// The two invariants everything reduces to:
//
// 1. OWNERSHIP — every base load takes a fresh generation; only the newest
//    generation may publish. A confirmed folder scan also takes a generation
//    (without a load), so anything parsing when a new folder arrives can no
//    longer commit over it. Navigation adds one weaker layer: a queued
//    target that moved on makes its own load stale without a new generation.
//
// 2. SETTLEMENT — the generation that raised the loading flag owns it, and
//    exactly one party settles it: the commit/fail if the load stays
//    current, the discard if it goes stale while still owning the flag, or
//    the scan confirmation that invalidated it. Nothing else touches it, so
//    the flag can neither stick forever nor be cleared out from under a
//    newer load.

export interface OpenedBytes {
  name: string
  bytes: ArrayBuffer
}

export interface ScanResult {
  root: string
  files: FolderEntry[]
  truncated: boolean
}

/** The slice of app state the coordinator's decisions depend on. */
export interface CoordinatorSnapshot {
  sourcePath: string | null
  loading: boolean
  scanning: boolean
  folderRoot: string | null
  folderFiles: FolderEntry[] | null
}

/** Every effect the coordinator can have on the world, injected so the
 * orchestration itself stays pure and testable. */
export interface CoordinatorEffects<V> {
  snapshot(): CoordinatorSnapshot
  /** Read one folder entry's bytes. */
  read(path: string): Promise<OpenedBytes>
  /** Read a folder entry only when its size is within maxBytes; null
   * otherwise. The gate must sit on the far side of the boundary so an
   * oversized file is never read or transferred at all. */
  readWithin(path: string, maxBytes: number): Promise<OpenedBytes | null>
  parseBase(name: string, bytes: ArrayBuffer): Promise<V>
  commitBase(volume: V, path: string | null): void
  /** Parse and attach an overlay layer; reports its own domain failures. */
  parseAndAddOverlay(name: string, bytes: ArrayBuffer): Promise<void>
  /** May veto replacing the base (unsaved region work). */
  confirmReplaceBase(): boolean
  raiseLoading(): void
  dismissLoading(): void
  /** A parse failed while its load was still current. */
  failParse(err: unknown): void
  /** A folder-entry read failed. */
  failRead(err: unknown): void
  setPending(path: string | null): void
  setFolder(folder: ScanResult): void
  appendFolder(root: string, files: FolderEntry[]): void
  setScanning(b: boolean): void
}

// Prefetches above this size are skipped entirely (never read, never
// transferred): pinning buffers that big buys less than it costs.
export const PREFETCH_KEEP_MAX = 512 * 1024 * 1024

export class LoadCoordinator<V> {
  private readonly fx: CoordinatorEffects<V>
  private readonly prefetchMax: number
  private readonly deferAutoLoad: (entry: FolderEntry) => boolean

  // Ownership generation: every base load takes one; a confirmed scan bumps
  // it without a load. Only the newest generation may publish.
  private baseGen = 0
  // The generation that raised the loading flag and has not settled it yet
  // (null once settled, or when an overlay op is carrying the flag).
  private loadingOwner: number | null = null

  // Navigation is a queue of one: key presses only move the target; the pump
  // loads whatever the target is once the current load settles, discarding
  // reads that went stale along the way. Holding a key therefore scrubs to a
  // destination instead of grinding through every file in between.
  private queued: string | null = null
  private pumpActive = false

  // One-slot byte cache for the file the next key press most likely wants
  // (the neighbor in the last direction travelled). Consuming a hit skips
  // the disk read — the slowest step on external drives.
  private prefetched: { path: string; bytes: ArrayBuffer } | null = null
  private prefetchActive = false
  private lastDelta: 1 | -1 = 1

  // Scan generation, echoed by the scanner in every progress batch: anything
  // not carrying the current one is a superseded scan and gets ignored.
  private scanGen = 0
  // The scan generation that has been CONFIRMED (first batch or final
  // result): confirmation is when the old world gets invalidated and the new
  // list starts fresh — never at scan start, where a canceled picker would
  // kill unrelated work.
  private confirmedScanGen = 0
  // Armed when a scan starts; the first non-empty view of the folder
  // consumes it, so the folder's first file loads exactly once.
  private autoLoadArmed = false

  constructor(
    fx: CoordinatorEffects<V>,
    opts?: {
      prefetchMax?: number
      /** Entries the snapshot may still drop as more of the scan streams in
       * (e.g. a region export whose source volume has not arrived yet). The
       * auto-load never picks one from a partial batch — only the final scan
       * knows whether such an entry really stays in the list. */
      deferAutoLoad?: (entry: FolderEntry) => boolean
    }
  ) {
    this.fx = fx
    this.prefetchMax = opts?.prefetchMax ?? PREFETCH_KEEP_MAX
    this.deferAutoLoad = opts?.deferAutoLoad ?? (() => false)
  }

  /** Explicit base open (dialog, menu, drop): supersedes a running scan and
   * any load in flight. */
  async openBase(name: string, bytes: ArrayBuffer, path: string | null): Promise<void> {
    // Confirm before any side effect: declining must leave the world exactly
    // as it was — including a scan still streaming its batches.
    if (!this.fx.confirmReplaceBase()) return
    // The user's confirmed pick wins over a folder scan still in flight.
    if (this.fx.snapshot().scanning) this.abandonScan()
    await this.runBaseLoad(name, bytes, path)
  }

  /** Overlay open: never contends for the base, so no generation. The op
   * settles the loading flag itself on every path (commit or fail). */
  async openOverlay(name: string, bytes: ArrayBuffer): Promise<void> {
    this.loadingOwner = null
    this.fx.raiseLoading()
    try {
      await this.fx.parseAndAddOverlay(name, bytes)
    } catch (err) {
      this.fx.failParse(err)
    }
  }

  /** Move the navigation target to this folder entry. */
  requestEntry(path: string): void {
    this.queued = path
    this.fx.setPending(path)
    void this.pump()
  }

  /** Move the navigation target to the previous/next file (no wrap). */
  navigate(delta: 1 | -1): void {
    const snap = this.fx.snapshot()
    if (!snap.folderFiles) return
    this.lastDelta = delta
    const idx = adjacentIndex(snap.folderFiles, this.queued ?? snap.sourcePath, delta)
    if (idx !== null) this.requestEntry(snap.folderFiles[idx].path)
  }

  /** Run a scan into folder mode; false when the source is not a directory
   * (or the picker was canceled). The list fills from streamed batches while
   * the scan runs; the resolved scan is the authoritative final state. */
  async scanFolder(scan: (token: number) => Promise<ScanResult | null>): Promise<boolean> {
    const gen = ++this.scanGen
    this.autoLoadArmed = true
    this.fx.setScanning(true)
    try {
      const result = await scan(gen)
      if (gen !== this.scanGen) return true // superseded by an explicit action
      if (!result) return false
      // Covers scans that produced no batches (e.g. an empty folder).
      this.confirmScan()
      this.fx.setFolder({
        root: result.root,
        files: sortEntries(result.files),
        truncated: result.truncated
      })
      this.maybeAutoLoad(true)
      return true
    } finally {
      if (gen === this.scanGen) {
        this.autoLoadArmed = false
        this.fx.setScanning(false)
      }
    }
  }

  /** A streamed scan batch arrived. The token gate keeps a superseded scan
   * (still streaming) from mutating the list the newer scan owns; the first
   * batch of a scan always starts a FRESH list, so re-scanning the same root
   * cannot resurrect entries that no longer exist. */
  onScanBatch(token: number, root: string, files: FolderEntry[]): void {
    if (token !== this.scanGen) return
    if (this.confirmScan()) {
      this.fx.setFolder({ root, files: sortEntries(files), truncated: false })
    } else {
      this.fx.appendFolder(root, files)
    }
    this.maybeAutoLoad(false)
  }

  /** An explicit user action supersedes a running scan: its remaining
   * batches and final result are ignored rather than fighting the user's
   * choice. The scan itself just runs out harmlessly. */
  abandonScan(): void {
    this.scanGen++
    this.autoLoadArmed = false
    this.fx.setScanning(false)
  }

  /** The folder closed (e.g. an outside file replaced it): release the
   * cached bytes instead of pinning them until the next navigation. */
  releasePrefetch(): void {
    this.prefetched = null
  }

  /** Every base load funnels through here; the generation check at commit
   * time is what makes "whichever started last owns the view" hold across
   * dialog, menu, drop, and folder navigation. `isStaleTarget` is the
   * navigation pump's weaker staleness: the queued target moving on does not
   * start another load, so the generation alone would miss it. */
  private async runBaseLoad(
    name: string,
    bytes: ArrayBuffer,
    path: string | null,
    isStaleTarget?: () => boolean
  ): Promise<void> {
    const gen = ++this.baseGen
    this.loadingOwner = gen
    this.fx.raiseLoading()
    try {
      const volume = await this.fx.parseBase(name, bytes)
      if (gen !== this.baseGen || isStaleTarget?.()) {
        this.settleIfOwner(gen)
        return
      }
      this.loadingOwner = null
      this.fx.commitBase(volume, path)
    } catch (err) {
      if (gen !== this.baseGen || isStaleTarget?.()) {
        // A superseded target's failure (e.g. a corrupt file the user
        // already scrubbed past) is not the current view's problem.
        this.settleIfOwner(gen)
        return
      }
      this.loadingOwner = null
      this.fx.failParse(err)
    }
  }

  /** A load discards its result: settle the loading flag only if this load
   * still owns it. A newer load owns it now → leave it raised for them; a
   * scan confirmation already settled it → nothing to do. */
  private settleIfOwner(gen: number): void {
    if (this.loadingOwner === gen) {
      this.loadingOwner = null
      this.fx.dismissLoading()
    }
  }

  /** First contact with a scan's results makes it real: exactly once per
   * scan, stop the pump chasing pre-scan targets and invalidate any base
   * parse still in flight, so neither can publish over the new folder.
   * Returns true on that first confirmation (the caller starts a fresh
   * list); false when this scan was already confirmed. */
  private confirmScan(): boolean {
    if (this.confirmedScanGen === this.scanGen) return false
    this.confirmedScanGen = this.scanGen
    this.queued = null
    this.baseGen++
    // The invalidated parse can never publish now, so its loading flag is
    // ownerless — settle it here rather than leaving it raised forever
    // (this scan may trigger no load of its own).
    if (this.loadingOwner !== null) {
      this.loadingOwner = null
      this.fx.dismissLoading()
    }
    return true
  }

  private maybeAutoLoad(final: boolean): void {
    if (!this.autoLoadArmed) return
    const snap = this.fx.snapshot()
    if (!snap.folderRoot || !snap.folderFiles || snap.folderFiles.length === 0) return
    const src = snap.sourcePath
    // A loaded file that sits under the root may simply not have streamed in
    // yet — deciding to replace it belongs to the final scan, not a batch.
    if (!final && src !== null && isUnderRoot(snap.folderRoot, src)) return
    if (snap.folderFiles.some((f) => f.path === src)) {
      this.autoLoadArmed = false
      return
    }
    // Batches are partial views of the folder: an entry that may yet drop out
    // of the list (deferAutoLoad) is not picked from one. When only such
    // entries have streamed in so far, stay armed and let a later batch — or
    // the final result, which loads whatever genuinely tops the list — decide.
    const target = final
      ? snap.folderFiles[0]
      : snap.folderFiles.find((f) => !this.deferAutoLoad(f))
    if (!target) return
    this.autoLoadArmed = false
    this.requestEntry(target.path)
  }

  private async pump(): Promise<void> {
    if (this.pumpActive) return
    this.pumpActive = true
    try {
      while (this.queued) {
        const snap = this.fx.snapshot()
        const path = this.queued
        if (path === snap.sourcePath) break
        // An explicit open already parsing wins over queued navigation. This
        // sits before the prefetch branch: cached bytes skip the read (and
        // its post-await re-checks), and without it a cache hit would grab a
        // newer generation and stale the user's own open.
        if (snap.loading) break
        const entry = snap.folderFiles?.find((f) => f.path === path)
        if (!entry) break
        try {
          let opened: OpenedBytes
          if (this.prefetched?.path === path) {
            opened = { name: entry.name, bytes: this.prefetched.bytes }
            this.prefetched = null // the load transfers the buffer away
          } else {
            opened = await this.fx.read(path)
            // The target moved on while this file was being read: drop the
            // bytes unparsed and chase the newer target.
            if (this.queued !== path) continue
            // An explicit open may have started or landed meanwhile, or the
            // folder itself was replaced — the user's choice wins over
            // stale folder navigation.
            const now = this.fx.snapshot()
            if (
              now.loading ||
              now.sourcePath !== snap.sourcePath ||
              !now.folderFiles?.some((f) => f.path === path)
            ) {
              break
            }
          }
          // Navigation replaces the base too, so it gets the same veto over
          // discarding unexported region work as an explicit open.
          if (!this.fx.confirmReplaceBase()) break
          await this.runBaseLoad(opened.name, opened.bytes, path, () => this.queued !== path)
        } catch (err) {
          // A stale read's failure mirrors a stale read's success: when the
          // target moved on, chase it instead of reporting an error for a
          // file nobody is waiting on; when the world changed under us, an
          // explicit action owns the view — stand down silently.
          if (this.queued !== path) continue
          const now = this.fx.snapshot()
          if (
            now.loading ||
            now.sourcePath !== snap.sourcePath ||
            !now.folderFiles?.some((f) => f.path === path)
          ) {
            break
          }
          this.fx.failRead(err)
          break
        }
        if (this.queued === path) break
      }
    } finally {
      this.queued = null
      this.pumpActive = false
      this.fx.setPending(null)
      this.schedulePrefetch()
    }
  }

  /** After navigation settles, read the neighbor in the direction of travel
   * so the next key press starts from parsing instead of the disk. */
  private schedulePrefetch(): void {
    if (this.prefetchActive) return
    const snap = this.fx.snapshot()
    if (!snap.folderFiles || snap.sourcePath === null) return
    const idx = adjacentIndex(snap.folderFiles, snap.sourcePath, this.lastDelta)
    if (idx === null) return
    const target = snap.folderFiles[idx]
    if (this.prefetched?.path === target.path) return
    this.prefetchActive = true
    this.fx
      .readWithin(target.path, this.prefetchMax)
      .then((opened) => {
        if (!opened) return // over the size cap — deliberately not read
        // Keep the bytes only if the entry still belongs to the open folder.
        const cur = this.fx.snapshot()
        if (cur.folderFiles?.some((f) => f.path === target.path)) {
          this.prefetched = { path: target.path, bytes: opened.bytes }
        }
      })
      .catch(() => {
        // Prefetch is opportunistic; the real read will surface any error.
      })
      .finally(() => {
        this.prefetchActive = false
      })
  }
}
