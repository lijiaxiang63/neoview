import { adjacentIndex, isUnderRoot, sortEntries, type FolderEntry } from './folderList'
import type { FolderScan, OpenedFile } from '../../../shared/files'

// All load/scan orchestration lives in this one pure module so its
// interleavings are unit-testable (tests/loadCoordinator.test.ts): every
// async operation (read, parse, scan) crossed with every user entry point
// (explicit open, drop, folder navigation, folder open) is a potential race,
// and the guards below are exactly the invariants those tests pin down.
//
// The two invariants everything reduces to:
//
// 1. DATA OWNERSHIP — every base load takes a fresh generation; only the
//    newest generation may publish. Base replacement and confirmed folder
//    scans also invalidate the layer session, so layers parsed against the
//    prior base cannot attach. Navigation adds one weaker layer: a queued
//    target that moved on makes its own load stale without a new generation.
//
// 2. FEEDBACK SETTLEMENT — every concurrently valid base/layer operation
//    joins one active group. Members publish data independently, but shared
//    loading/error feedback settles only after the group empties; any failure
//    wins over success. A newer base/folder invalidates the group, and a
//    direct newer non-loading error is never cleared by late settlement.

export type OpenedBytes = Pick<OpenedFile, 'name' | 'bytes'>

export type ScanResult = FolderScan

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
  /** Commit data without settling the shared loading/error status. */
  commitBase(volume: V, path: string | null): void
  /** Parse and attach an overlay layer without settling shared status. */
  parseAndAddOverlay(name: string, bytes: ArrayBuffer, isCurrent: () => boolean): Promise<void>
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
  /** Confirm or cancel one main-side scan by its generation token. */
  confirmScan(token: number): void
  cancelScan(token: number): void
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
  // Base and same-session overlays can be valid concurrently. The shared
  // feedback settles only after every still-current operation finishes.
  private nextLoadId = 0
  private readonly activeLoads = new Set<number>()
  private loadFailures: unknown[] = []
  // Base replacement/folder confirmation invalidates overlays parsing
  // against the prior base without making concurrent same-base layers race.
  private overlaySessionGen = 0

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
  private prefetchGen = 0
  private prefetchActiveGen: number | null = null
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
  private disposed = false

  constructor(
    fx: CoordinatorEffects<V>,
    opts?: {
      prefetchMax?: number
      /** Entries the snapshot may still drop as more of the scan streams in
       * (e.g. a region export whose source volume has not arrived yet). While
       * one of these heads the list, a partial batch cannot know the folder's
       * true first file — it may fold away or turn out to BE the first file —
       * so the auto-load waits for the final scan instead of picking anything. */
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
    if (this.disposed) return
    // Confirm before any side effect: declining must leave the world exactly
    // as it was — including a scan still streaming its batches.
    if (!this.fx.confirmReplaceBase()) return
    // The user's confirmed pick wins over a folder scan still in flight.
    if (this.fx.snapshot().scanning) this.abandonScan()
    await this.runBaseLoad(name, bytes, path)
  }

  /** Overlay data may attach alongside another layer, but its shared loading
   * status is operation-owned and a base/folder session invalidates its data. */
  async openOverlay(name: string, bytes: ArrayBuffer): Promise<void> {
    if (this.disposed) return
    const session = this.overlaySessionGen
    const loadId = this.beginLoading()
    try {
      await this.fx.parseAndAddOverlay(
        name,
        bytes,
        () => !this.disposed && session === this.overlaySessionGen
      )
      if (this.disposed) return
      this.finishLoad(loadId, false)
    } catch (err) {
      if (this.disposed) return
      if (session !== this.overlaySessionGen) return
      this.finishLoad(loadId, true, err)
    }
  }

  /** Move the navigation target to this folder entry. */
  requestEntry(path: string): void {
    if (this.disposed) return
    // A pick from the CURRENT scan's list claims its view: the auto-load may
    // still be armed (it waits while the list's head entry is ambiguous), and
    // a later batch firing it would override the choice — disarm it. Confirmed
    // is the gate: before it, the visible list is still the previous folder's,
    // and a pick there is doomed to be invalidated by the confirmation anyway —
    // it must not eat the incoming folder's one auto-load. (The auto-load's own
    // picks route through here after confirmation, consuming the flag.)
    if (this.confirmedScanGen === this.scanGen) this.autoLoadArmed = false
    this.queued = path
    this.fx.setPending(path)
    void this.pump()
  }

  /** Move the navigation target to the previous/next file (no wrap). */
  navigate(delta: 1 | -1): void {
    if (this.disposed) return
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
    if (this.disposed) return false
    // A directory drop may replace a scan even though the picker flow itself
    // prevents re-entry. Settle its main-side candidate before issuing the new
    // request, preserving it only if this renderer already confirmed a batch.
    if (this.fx.snapshot().scanning) {
      this.fx.cancelScan(this.scanGen)
    }
    const gen = ++this.scanGen
    this.autoLoadArmed = true
    this.fx.setScanning(true)
    try {
      const result = await scan(gen)
      if (this.disposed) return false
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
    } catch (error) {
      if (this.disposed) return false
      if (gen !== this.scanGen) return true
      this.fx.cancelScan(gen)
      throw error
    } finally {
      if (!this.disposed && gen === this.scanGen) {
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
    if (this.disposed || token !== this.scanGen) return
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
    if (this.disposed) return
    const token = this.scanGen
    this.scanGen++
    this.autoLoadArmed = false
    this.fx.setScanning(false)
    this.fx.cancelScan(token)
  }

  /** The folder closed (e.g. an outside file replaced it): release the
   * cached bytes instead of pinning them until the next navigation. */
  releasePrefetch(): void {
    this.prefetchGen++
    this.prefetchActiveGen = null
    this.prefetched = null
  }

  /** Permanently invalidate this coordinator and release every owned
   * reference. Pending promises may still settle, but their results are
   * ignored and can no longer reach the injected effects. */
  dispose(): void {
    if (this.disposed) return
    const snapshot = this.fx.snapshot()
    const scanToken = this.scanGen
    const hadNavigation = this.queued !== null || this.pumpActive
    this.disposed = true
    this.baseGen++
    this.invalidateOverlaySession()
    this.scanGen++
    this.queued = null
    this.autoLoadArmed = false
    this.releasePrefetch()
    this.invalidateLoadGroup()
    if (snapshot.scanning) {
      this.fx.cancelScan(scanToken)
      this.fx.setScanning(false)
    }
    if (hadNavigation) this.fx.setPending(null)
    if (snapshot.loading) this.fx.dismissLoading()
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
    if (this.disposed) return
    const gen = ++this.baseGen
    this.invalidateOverlaySession()
    this.invalidateLoadGroup()
    const loadId = this.beginLoading()
    try {
      const volume = await this.fx.parseBase(name, bytes)
      if (this.disposed) return
      if (gen !== this.baseGen || isStaleTarget?.()) {
        this.finishLoad(loadId, false)
        return
      }
      this.fx.commitBase(volume, path)
      this.finishLoad(loadId, false)
    } catch (err) {
      if (this.disposed) return
      if (gen !== this.baseGen || isStaleTarget?.()) {
        // A superseded target's failure (e.g. a corrupt file the user
        // already scrubbed past) is not the current view's problem.
        this.finishLoad(loadId, false)
        return
      }
      this.finishLoad(loadId, true, err)
    }
  }

  private beginLoading(): number {
    const loadId = ++this.nextLoadId
    this.activeLoads.add(loadId)
    this.fx.raiseLoading()
    return loadId
  }

  private finishLoad(loadId: number, failedThisOperation: boolean, error?: unknown): void {
    if (!this.activeLoads.delete(loadId)) return
    if (failedThisOperation) this.loadFailures.push(error)
    if (this.activeLoads.size > 0) return
    const failure = this.loadFailures.at(-1)
    const failed = this.loadFailures.length > 0
    this.loadFailures = []
    // A direct bridge error can settle feedback without going through this
    // coordinator. Never overwrite or dismiss that newer non-loading state.
    if (this.disposed || !this.fx.snapshot().loading) return
    if (failed) this.fx.failParse(failure)
    else this.fx.dismissLoading()
  }

  private invalidateOverlaySession(): void {
    this.overlaySessionGen++
  }

  private invalidateLoadGroup(): void {
    this.activeLoads.clear()
    this.loadFailures = []
  }

  /** First contact with a scan's results makes it real: exactly once per
   * scan, stop the pump chasing pre-scan targets and invalidate any base
   * parse still in flight, so neither can publish over the new folder.
   * Returns true on that first confirmation (the caller starts a fresh
   * list); false when this scan was already confirmed. */
  private confirmScan(): boolean {
    if (this.confirmedScanGen === this.scanGen) return false
    this.confirmedScanGen = this.scanGen
    this.fx.confirmScan(this.scanGen)
    this.queued = null
    // A confirmed scan starts a new folder session even when its root and
    // paths match the previous one. Never carry bytes across that boundary.
    this.releasePrefetch()
    this.baseGen++
    this.invalidateOverlaySession()
    // The invalidated parse can never publish now, so its loading flag is
    // ownerless — settle it here rather than leaving it raised forever
    // (this scan may trigger no load of its own).
    this.invalidateLoadGroup()
    if (this.fx.snapshot().loading) this.fx.dismissLoading()
    return true
  }

  private maybeAutoLoad(final: boolean): void {
    if (this.disposed || !this.autoLoadArmed) return
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
    // The auto-load's contract is "the folder's first file". While the list's
    // head is an entry that may yet drop out (deferAutoLoad), a partial batch
    // cannot tell what the first file IS — the head may fold away, or survive
    // and be exactly the file to load. Either way the whole decision is
    // deferred (stay armed); skipping to a later entry would bake the wrong
    // pick in before the final result settles the head's fate.
    const first = snap.folderFiles[0]
    if (!final && this.deferAutoLoad(first)) return
    this.requestEntry(first.path)
  }

  private async pump(): Promise<void> {
    if (this.disposed || this.pumpActive) return
    this.pumpActive = true
    try {
      while (!this.disposed && this.queued) {
        const snap = this.fx.snapshot()
        const path = this.queued
        const folderSession = this.confirmedScanGen
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
            // A same-root rescan may put the identical path back into the
            // one-slot queue. Path equality alone cannot distinguish that
            // ABA case: bytes from the previous folder session must drop.
            if (folderSession !== this.confirmedScanGen) continue
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
          if (folderSession !== this.confirmedScanGen) continue
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
      if (!this.disposed) {
        this.fx.setPending(null)
        this.schedulePrefetch()
      }
    }
  }

  /** After navigation settles, read the neighbor in the direction of travel
   * so the next key press starts from parsing instead of the disk. */
  private schedulePrefetch(): void {
    if (this.disposed || this.prefetchActiveGen === this.prefetchGen) return
    const snap = this.fx.snapshot()
    if (!snap.folderFiles || snap.sourcePath === null) return
    const idx = adjacentIndex(snap.folderFiles, snap.sourcePath, this.lastDelta)
    if (idx === null) return
    const target = snap.folderFiles[idx]
    if (this.prefetched?.path === target.path) return
    const gen = this.prefetchGen
    this.prefetchActiveGen = gen
    this.fx
      .readWithin(target.path, this.prefetchMax)
      .then((opened) => {
        if (this.disposed || gen !== this.prefetchGen || !opened) return
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
        if (this.prefetchActiveGen === gen) this.prefetchActiveGen = null
      })
  }
}
