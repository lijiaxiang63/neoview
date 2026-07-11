/** One document-bound base-open operation owned by the main process. */
export interface OpenJobScope<Owner extends object> {
  readonly owner: Owner
  readonly epoch: number
}

export interface OpenJob<Owner extends object> extends OpenJobScope<Owner> {
  readonly intent: number
  readonly signal: AbortSignal
}

interface ActiveJob<Owner extends object> extends OpenJob<Owner> {
  readonly abort: AbortController
}

function validIntent(intent: unknown): intent is number {
  return typeof intent === 'number' && Number.isSafeInteger(intent) && intent > 0
}

/**
 * Application-owned ordering and cancellation for main-side base reads.
 * Intent issuance and reads remain provisional; `accept` is called only
 * after the renderer accepts replacement, a scan activates, or a terminal
 * error becomes authoritative.
 */
export class OpenJobCoordinator<Owner extends object> {
  private latestAccepted = 0
  private readonly ownerEpochs = new WeakMap<Owner, number>()
  private readonly active = new Set<ActiveJob<Owner>>()

  capture(owner: Owner): OpenJobScope<Owner> {
    return { owner, epoch: this.epochOf(owner) }
  }

  scopeIsCurrent(scope: OpenJobScope<Owner>): boolean {
    return scope.epoch === this.epochOf(scope.owner)
  }

  /** Accept one terminal user intent and abort every older main-side read. */
  accept(intent: unknown): boolean {
    if (!validIntent(intent) || intent < this.latestAccepted) return false
    if (intent === this.latestAccepted) return true
    this.latestAccepted = intent
    for (const job of this.active) {
      if (job.intent < intent) this.abort(job)
    }
    return true
  }

  begin(intent: unknown, scope: OpenJobScope<Owner>): OpenJob<Owner> | null {
    if (!validIntent(intent) || !this.scopeIsCurrent(scope) || intent < this.latestAccepted) {
      return null
    }
    for (const job of this.active) {
      if (job.intent === intent) this.abort(job)
    }
    const abort = new AbortController()
    const job: ActiveJob<Owner> = {
      ...scope,
      intent,
      signal: abort.signal,
      abort
    }
    this.active.add(job)
    return job
  }

  isCurrent(job: OpenJob<Owner>): boolean {
    return (
      !job.signal.aborted &&
      this.active.has(job as ActiveJob<Owner>) &&
      job.intent >= this.latestAccepted &&
      this.scopeIsCurrent(job)
    )
  }

  finish(job: OpenJob<Owner>): void {
    this.active.delete(job as ActiveJob<Owner>)
  }

  /** Navigation/process loss makes every completion from that document inert. */
  invalidateOwner(owner: Owner): void {
    this.ownerEpochs.set(owner, this.epochOf(owner) + 1)
    for (const job of this.active) {
      if (job.owner === owner) this.abort(job)
    }
  }

  current(): number {
    return this.latestAccepted
  }

  private epochOf(owner: Owner): number {
    return this.ownerEpochs.get(owner) ?? 0
  }

  private abort(job: ActiveJob<Owner>): void {
    this.active.delete(job)
    job.abort.abort()
  }
}
