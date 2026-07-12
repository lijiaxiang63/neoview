import { adjacentIndex, isUnderRoot, sortEntries, type FolderEntry } from './folderList'
import type { FolderScan, OpenedFile } from '../../../shared/files'
import { OpenIntentGate } from '../../../shared/openIntents'
import { LoadFeedbackGroup, PrefetchSlot } from './loadOwnership'
import type { LayerLabelTable } from '../slicing/labelTable'

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

export interface OverlayLoadMetadata {
  sourcePath: string | null
  labelTable: LayerLabelTable | null
  labelTableName?: string | null
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
  read(path: string, signal: AbortSignal): Promise<OpenedBytes>
  /** Read a folder entry only when its size is within maxBytes; null
   * otherwise. The gate must sit on the far side of the boundary so an
   * oversized file is never read or transferred at all. */
  readWithin(path: string, maxBytes: number, signal: AbortSignal): Promise<OpenedBytes | null>
  parseBase(name: string, bytes: ArrayBuffer, signal: AbortSignal): Promise<V>
  /** Release resources attached to a parsed base that lost ownership before commit. */
  releaseBase?(volume: V): void
  /** Commit data without settling the shared loading/error status. */
  commitBase(volume: V, path: string | null): void
  /** Parse and attach an overlay layer without settling shared status. */
  parseAndAddOverlay(
    name: string,
    bytes: ArrayBuffer,
    metadata: OverlayLoadMetadata,
    isCurrent: () => boolean,
    signal: AbortSignal
  ): Promise<void>
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

type BaseLoadResult = 'settled' | 'cancelled'

interface ActiveBaseParse {
  id: number
  kind: 'explicit' | 'navigation'
  path: string | null
  abort: AbortController
}

interface ActiveNavigationRead {
  id: number
  path: string
  abort: AbortController
}

export class LoadCoordinator<V> {
  private readonly fx: CoordinatorEffects<V>
  private readonly prefetchMax: number
  private readonly deferAutoLoad: (entry: FolderEntry) => boolean

  // Ownership generation: every base load takes one; a confirmed scan bumps
  // it without a load. Only the newest generation may publish.
  private baseGen = 0
  // Base and same-session overlays can be valid concurrently. The shared
  // feedback settles only after every still-current operation finishes.
  private readonly loadFeedback = new LoadFeedbackGroup()
  // Base replacement/folder confirmation invalidates overlays parsing
  // against the prior base without making concurrent same-base layers race.
  private overlaySessionGen = 0
  private readonly overlayParses = new Map<AbortController, number>()
  private nextBaseOperationId = 0
  private activeBaseParse: ActiveBaseParse | null = null
  private nextReadOperationId = 0
  private activeNavigationRead: ActiveNavigationRead | null = null
  /** One accepted discard decision covers a coalesced navigation batch, so
   * key repeat can keep moving the target without reopening the prompt. */
  private navigationAuthorized = false
  // Cross-process user-intent ordering is issued before any outer I/O. The
  // coordinator accepts the token only when that operation reaches it, so a
  // cancelled picker has no effect while an older slow result cannot arrive
  // after and claim newer ownership.
  private readonly intentGate: OpenIntentGate
  private readonly onIntentAccepted: (token: number) => void
  private syntheticIntent = 0
  /** Intent reserved by the current folder picker/scan. It remains
   * provisional until a batch or non-null final result proves that the user
   * selected a folder; cancellation therefore advances no global gate. */
  private scanIntent = 0

  // Navigation is a queue of one: key presses only move the target; the pump
  // loads whatever the target is once the current load settles, discarding
  // reads that went stale along the way. Holding a key therefore scrubs to a
  // destination instead of grinding through every file in between.
  private queued: string | null = null
  private pumpActive = false

  // One-slot byte cache for the file the next key press most likely wants
  // (the neighbor in the last direction travelled). Consuming a hit skips
  // the disk read — the slowest step on external drives.
  private readonly prefetch = new PrefetchSlot()
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
      /** Store-lifetime ordering gate shared by runtime replacements. */
      intentGate?: OpenIntentGate
      /** Promote a provisional application token after this coordinator has
       * accepted it, allowing main-side obsolete reads to abort early. */
      onIntentAccepted?: (token: number) => void
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
    this.intentGate = opts?.intentGate ?? new OpenIntentGate()
    this.onIntentAccepted = opts?.onIntentAccepted ?? (() => {})
  }

  /** Explicit base open (dialog, menu, drop): supersedes a running scan and
   * any load in flight. */
  async openBase(
    name: string,
    bytes: ArrayBuffer,
    path: string | null,
    intent?: number
  ): Promise<void> {
    if (this.disposed) return
    const token = this.intentToken(intent)
    if (token < this.intentGate.current()) return
    // Confirm before any side effect: declining must leave the world exactly
    // as it was — including a scan still streaming its batches.
    if (!this.fx.confirmReplaceBase()) return
    if (!this.acceptIntent(token)) return
    // An accepted explicit open permanently supersedes the folder read that
    // was current at this instant. A transient "explicit parse active" check
    // after the read settles is insufficient: the explicit operation may
    // already have succeeded or failed by then, including at the same path.
    this.queued = null
    this.navigationAuthorized = false
    this.abortNavigationRead()
    this.cancelPrefetchRead()
    this.fx.setPending(null)
    // The user's confirmed pick wins over a folder scan still in flight.
    // An older result may arrive while a newer picker is still provisional;
    // let that load proceed without cancelling the newer picker. A confirmed
    // scan will invalidate it when its first result arrives.
    if (this.fx.snapshot().scanning && token >= this.scanIntent) this.abandonScan()
    await this.runBaseLoad(name, bytes, path)
  }

  /** Complete a base intent with an error. Errors participate in the same
   * ordering as successes so an older failure cannot replace newer feedback,
   * while a picker cancellation never calls this and remains inert. */
  reportBaseError(error: unknown, intent?: number): void {
    if (this.disposed) return
    if (intent !== undefined && !this.acceptFailedIntent(intent)) return
    if (intent !== undefined && this.fx.snapshot().scanning && intent >= this.scanIntent) {
      this.abandonScan()
    }
    // Direct bridge and validation failures may already be plain display
    // strings. Preserve them through the shared IPC-error cleanup boundary.
    this.fx.failRead(typeof error === 'string' ? new Error(error) : error)
  }

  /** Overlay data may attach alongside another layer, but its shared loading
   * status is operation-owned and a base/folder session invalidates its data. */
  async openOverlay(
    name: string,
    bytes: ArrayBuffer,
    metadata: OverlayLoadMetadata = { sourcePath: null, labelTable: null, labelTableName: null }
  ): Promise<void> {
    if (this.disposed) return
    const session = this.overlaySessionGen
    const loadId = this.beginLoading()
    const abort = new AbortController()
    this.overlayParses.set(abort, loadId)
    try {
      await this.fx.parseAndAddOverlay(
        name,
        bytes,
        metadata,
        () => !this.disposed && session === this.overlaySessionGen,
        abort.signal
      )
      if (this.disposed) return
      this.finishLoad(loadId, false)
    } catch (err) {
      if (this.disposed) return
      if (abort.signal.aborted || session !== this.overlaySessionGen) return
      this.finishLoad(loadId, true, err)
    } finally {
      this.overlayParses.delete(abort)
    }
  }

  /** Move the navigation target to this folder entry. */
  requestEntry(path: string, intent?: number): void {
    if (this.disposed) return
    const token = this.intentToken(intent)
    const snapshot = this.fx.snapshot()
    if (path === snapshot.sourcePath) {
      // The active row is a no-op replacement, but it is also the user's way
      // back from a queued/ parsing navigation target. It must cancel that
      // work without asking to discard the very volume that remains active.
      this.queued = null
      this.abortNavigationRead()
      this.abortStaleNavigationParse(path)
      this.navigationAuthorized = false
      this.fx.setPending(null)
      if (!this.pumpActive) this.schedulePrefetch()
      return
    }
    const provisionalScan = snapshot.scanning && this.confirmedScanGen !== this.scanGen
    if (token < this.intentGate.current()) return
    // Disarm before asking: a declined folder auto-load is still a completed
    // user decision and later scan batches must not reopen the same prompt.
    if (this.confirmedScanGen === this.scanGen) this.autoLoadArmed = false
    // The first target in one queue-of-one batch owns the discard decision.
    // Repeated key targets reuse it until the pump settles, preserving fast
    // scrubbing without accepting anything when that first prompt is declined.
    let authorizedNow = false
    if (!this.navigationAuthorized) {
      if (!this.fx.confirmReplaceBase()) return
      this.navigationAuthorized = true
      authorizedNow = true
    }
    if (!this.acceptIntent(token)) {
      if (authorizedNow) this.navigationAuthorized = false
      return
    }
    // Until a selected folder produces a result, the previous list remains
    // interactive. A later click there is a later base-open intent: cancel
    // the provisional scan so main and renderer share one total ordering.
    if (provisionalScan) this.abandonScan()
    // A pick from the confirmed current list claims its view: the auto-load
    // may still be waiting on an ambiguous head, and a later batch must not
    // override the explicit choice. The provisional case was canceled above.
    this.queued = path
    this.abortStaleNavigationRead(path)
    this.abortStaleNavigationParse(path)
    this.fx.setPending(path)
    void this.pump()
  }

  /** Move the navigation target to the previous/next file (no wrap). */
  navigate(delta: 1 | -1, intent?: number): void {
    if (this.disposed) return
    const snap = this.fx.snapshot()
    if (!snap.folderFiles) return
    this.lastDelta = delta
    const idx = adjacentIndex(snap.folderFiles, this.queued ?? snap.sourcePath, delta)
    if (idx !== null) this.requestEntry(snap.folderFiles[idx].path, intent)
  }

  /** Run a scan into folder mode; false when the source is not a directory
   * (or the picker was canceled). The list fills from streamed batches while
   * the scan runs; the resolved scan is the authoritative final state. */
  async scanFolder(
    scan: (token: number) => Promise<ScanResult | null>,
    intent?: number
  ): Promise<boolean> {
    if (this.disposed) return false
    const token = this.intentToken(intent)
    if (token < this.intentGate.current()) return true
    if (this.fx.snapshot().scanning && token < this.scanIntent) return true
    // A directory drop may replace a scan even though the picker flow itself
    // prevents re-entry. Settle its main-side candidate before issuing the new
    // request, preserving it only if this renderer already confirmed a batch.
    if (this.fx.snapshot().scanning) {
      this.fx.cancelScan(this.scanGen)
    }
    // The base intent is issued outside the runtime before any picker/probe.
    // Reuse it across IPC so a replacement coordinator cannot recycle a
    // small local generation and accept an old runtime's queued batch (ABA).
    const gen = token
    this.scanGen = gen
    this.scanIntent = token
    this.autoLoadArmed = true
    this.fx.setScanning(true)
    try {
      const result = await scan(gen)
      if (this.disposed) return false
      if (gen !== this.scanGen) return true // superseded by an explicit action
      if (!result) {
        this.abandonScan()
        return false
      }
      // Covers scans that produced no batches (e.g. an empty folder).
      const activation = this.activateScan()
      if (activation === 'stale') return true
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
      // A real scan failure is a terminal result, unlike picker cancellation.
      // It therefore suppresses older operations and their late errors.
      if (!this.acceptFailedIntent(token)) {
        this.abandonScan()
        return true
      }
      this.abandonScan()
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
    const activation = this.activateScan()
    if (activation === 'stale') return
    if (activation === 'first') {
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
    this.scanGen = 0
    this.scanIntent = 0
    this.autoLoadArmed = false
    this.fx.setScanning(false)
    this.fx.cancelScan(token)
  }

  /** The folder closed (e.g. an outside file replaced it): release the
   * cached bytes instead of pinning them until the next navigation. */
  releasePrefetch(): void {
    this.prefetch.release()
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
    this.scanGen = 0
    this.queued = null
    this.navigationAuthorized = false
    this.abortNavigationRead()
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
  ): Promise<BaseLoadResult> {
    if (this.disposed) return 'cancelled'
    const gen = ++this.baseGen
    this.invalidateOverlaySession()
    this.invalidateLoadGroup()
    const loadId = this.beginLoading()
    const operation: ActiveBaseParse = {
      id: ++this.nextBaseOperationId,
      kind: isStaleTarget ? 'navigation' : 'explicit',
      path,
      abort: new AbortController()
    }
    this.activeBaseParse = operation
    try {
      const volume = await this.fx.parseBase(name, bytes, operation.abort.signal)
      if (
        this.disposed ||
        operation.abort.signal.aborted ||
        gen !== this.baseGen ||
        isStaleTarget?.()
      ) {
        this.fx.releaseBase?.(volume)
        this.finishLoad(loadId, false)
        return 'cancelled'
      }
      // A layer started while this base was pending necessarily parsed
      // against the previously committed base. Once replacement succeeds it
      // is obsolete: terminate any still-running workers and discard failures
      // that completed while the base kept the shared group open.
      this.invalidateOverlaySession()
      this.loadFeedback.forgetFailures()
      this.fx.commitBase(volume, path)
      this.finishLoad(loadId, false)
      return 'settled'
    } catch (err) {
      if (
        this.disposed ||
        operation.abort.signal.aborted ||
        gen !== this.baseGen ||
        isStaleTarget?.()
      ) {
        // A superseded target's failure (e.g. a corrupt file the user
        // already scrubbed past) is not the current view's problem.
        this.finishLoad(loadId, false)
        return 'cancelled'
      }
      this.finishLoad(loadId, true, err)
      return 'settled'
    } finally {
      if (this.activeBaseParse?.id === operation.id) this.activeBaseParse = null
    }
  }

  private beginLoading(): number {
    const loadId = this.loadFeedback.begin()
    this.fx.raiseLoading()
    return loadId
  }

  private finishLoad(loadId: number, failedThisOperation: boolean, error?: unknown): void {
    const settlement = this.loadFeedback.finish(loadId, failedThisOperation, error)
    if (!settlement) return
    // A direct bridge error can settle feedback without going through this
    // coordinator. Never overwrite or dismiss that newer non-loading state.
    if (this.disposed || !this.fx.snapshot().loading) return
    if (settlement.failed) this.fx.failParse(settlement.failure)
    else this.fx.dismissLoading()
  }

  private invalidateOverlaySession(): void {
    this.overlaySessionGen++
    for (const [abort, loadId] of this.overlayParses) {
      this.loadFeedback.drop(loadId)
      abort.abort()
    }
    this.overlayParses.clear()
  }

  private invalidateLoadGroup(): void {
    this.activeBaseParse?.abort.abort()
    this.loadFeedback.clear()
  }

  private abortStaleNavigationParse(path: string): void {
    const active = this.activeBaseParse
    if (active?.kind === 'navigation' && active.path !== path) active.abort.abort()
  }

  private abortStaleNavigationRead(path: string): void {
    const active = this.activeNavigationRead
    if (active && active.path !== path) active.abort.abort()
  }

  private abortNavigationRead(): void {
    this.activeNavigationRead?.abort.abort()
  }

  private cancelPrefetchRead(): void {
    this.prefetch.cancelActive()
  }

  private hasActiveExplicitBaseParse(): boolean {
    return this.activeBaseParse?.kind === 'explicit' && !this.activeBaseParse.abort.signal.aborted
  }

  /** First contact with a scan's results makes it real: exactly once per
   * scan, stop the pump chasing pre-scan targets and invalidate any base
   * parse still in flight, so neither can publish over the new folder.
   * Returns true on that first confirmation (the caller starts a fresh
   * list); false when this scan was already confirmed. */
  private activateScan(): 'first' | 'active' | 'stale' {
    if (this.confirmedScanGen === this.scanGen) return 'active'
    if (!this.acceptIntent(this.scanIntent)) {
      this.abandonScan()
      return 'stale'
    }
    this.confirmedScanGen = this.scanGen
    this.fx.confirmScan(this.scanGen)
    this.queued = null
    this.navigationAuthorized = false
    this.abortNavigationRead()
    // A confirmed scan starts a new folder session even when its root and
    // paths match the previous one. Never carry bytes across that boundary.
    this.releasePrefetch()
    this.baseGen++
    this.invalidateOverlaySession()
    // The invalidated parse can never publish now, so its loading flag is
    // ownerless — settle it here rather than leaving it raised forever
    // (this scan may trigger no load of its own).
    this.invalidateLoadGroup()
    // This confirmed newer intent owns feedback too: clear either an active
    // loading flag or an older read error left by the provisional old list.
    this.fx.dismissLoading()
    return 'first'
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
    this.requestEntry(first.path, this.intentGate.current())
  }

  private intentToken(intent: number | undefined): number {
    if (intent !== undefined) return intent
    this.syntheticIntent = Math.max(this.syntheticIntent, this.intentGate.current()) + 1
    return this.syntheticIntent
  }

  private acceptFailedIntent(token: number): boolean {
    if (!this.acceptIntent(token)) return false
    // A newer terminal failure keeps the current displayed volume, but any
    // older base parse still in flight must not publish after that failure.
    this.baseGen++
    this.activeBaseParse?.abort.abort()
    this.queued = null
    this.navigationAuthorized = false
    this.abortNavigationRead()
    this.fx.setPending(null)
    return true
  }

  private acceptIntent(token: number): boolean {
    const previous = this.intentGate.current()
    if (!this.intentGate.accept(token)) return false
    if (token > previous) this.onIntentAccepted(token)
    return true
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
        if (this.hasActiveExplicitBaseParse()) break
        const entry = snap.folderFiles?.find((f) => f.path === path)
        if (!entry) break
        let readSignal: AbortSignal | null = null
        try {
          let opened: OpenedBytes
          const prefetched = this.prefetch.take(path)
          if (prefetched) {
            opened = { name: entry.name, bytes: prefetched }
          } else {
            // A navigation read owns the target now; do not let an older
            // opportunistic read keep allocating the same or another file.
            this.cancelPrefetchRead()
            const readOperation: ActiveNavigationRead = {
              id: ++this.nextReadOperationId,
              path,
              abort: new AbortController()
            }
            this.activeNavigationRead = readOperation
            readSignal = readOperation.abort.signal
            try {
              opened = await this.fx.read(path, readOperation.abort.signal)
            } finally {
              if (this.activeNavigationRead?.id === readOperation.id) {
                this.activeNavigationRead = null
              }
            }
            if (readOperation.abort.signal.aborted) continue
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
              this.hasActiveExplicitBaseParse() ||
              now.sourcePath !== snap.sourcePath ||
              !now.folderFiles?.some((f) => f.path === path)
            ) {
              break
            }
          }
          const result = await this.runBaseLoad(
            opened.name,
            opened.bytes,
            path,
            () => this.queued !== path
          )
          if (result === 'cancelled') continue
        } catch (err) {
          // Cancellation is operation-owned, not path-owned. A→B→A must
          // restart A instead of surfacing AbortError from its first read.
          if (readSignal?.aborted) continue
          if (folderSession !== this.confirmedScanGen) continue
          // A stale read's failure mirrors a stale read's success: when the
          // target moved on, chase it instead of reporting an error for a
          // file nobody is waiting on; when the world changed under us, an
          // explicit action owns the view — stand down silently.
          if (this.queued !== path) continue
          const now = this.fx.snapshot()
          if (
            this.hasActiveExplicitBaseParse() ||
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
      this.navigationAuthorized = false
      this.pumpActive = false
      if (!this.disposed) {
        this.fx.setPending(null)
        if (!this.hasActiveExplicitBaseParse()) this.schedulePrefetch()
      }
    }
  }

  /** After navigation settles, read the neighbor in the direction of travel
   * so the next key press starts from parsing instead of the disk. */
  private schedulePrefetch(): void {
    if (this.disposed || this.prefetch.hasActiveGeneration()) return
    const snap = this.fx.snapshot()
    if (!snap.folderFiles || snap.sourcePath === null) return
    const idx = adjacentIndex(snap.folderFiles, snap.sourcePath, this.lastDelta)
    if (idx === null) return
    const target = snap.folderFiles[idx]
    if (this.prefetch.has(target.path)) return
    const operation = this.prefetch.begin()
    this.fx
      .readWithin(target.path, this.prefetchMax, operation.abort.signal)
      .then((opened) => {
        if (this.disposed || !this.prefetch.owns(operation) || !opened) return
        // Keep the bytes only if the entry still belongs to the open folder.
        const cur = this.fx.snapshot()
        if (cur.folderFiles?.some((f) => f.path === target.path)) {
          this.prefetch.store(operation, target.path, opened.bytes)
        }
      })
      .catch(() => {
        // Prefetch is opportunistic; the real read will surface any error.
      })
      .finally(() => {
        this.prefetch.finish(operation)
      })
  }
}
