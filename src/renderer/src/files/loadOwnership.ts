export interface LoadSettlement {
  failed: boolean
  failure: unknown
}

/** Pure membership/failure aggregation for concurrently valid load work. */
export class LoadFeedbackGroup {
  private nextId = 0
  private readonly active = new Set<number>()
  private failures: unknown[] = []

  begin(): number {
    const id = ++this.nextId
    this.active.add(id)
    return id
  }

  drop(id: number): void {
    this.active.delete(id)
  }

  forgetFailures(): void {
    this.failures = []
  }

  finish(id: number, failed: boolean, error?: unknown): LoadSettlement | null {
    if (!this.active.delete(id)) return null
    if (failed) this.failures.push(error)
    if (this.active.size > 0) return null
    const settlement = {
      failed: this.failures.length > 0,
      failure: this.failures.at(-1)
    }
    this.failures = []
    return settlement
  }

  clear(): void {
    this.active.clear()
    this.failures = []
  }
}

export interface PrefetchOperation {
  generation: number
  abort: AbortController
}

/** One cached neighbor plus ownership of its optional in-flight read. */
export class PrefetchSlot {
  private cached: { path: string; bytes: ArrayBuffer } | null = null
  private generation = 0
  private active: PrefetchOperation | null = null

  has(path: string): boolean {
    return this.cached?.path === path
  }

  take(path: string): ArrayBuffer | null {
    if (this.cached?.path !== path) return null
    const bytes = this.cached.bytes
    this.cached = null
    return bytes
  }

  hasActiveGeneration(): boolean {
    return this.active?.generation === this.generation
  }

  begin(): PrefetchOperation {
    const operation = { generation: this.generation, abort: new AbortController() }
    this.active = operation
    return operation
  }

  store(operation: PrefetchOperation, path: string, bytes: ArrayBuffer): boolean {
    if (!this.owns(operation)) return false
    this.cached = { path, bytes }
    return true
  }

  owns(operation: PrefetchOperation): boolean {
    return (
      this.active === operation &&
      operation.generation === this.generation &&
      !operation.abort.signal.aborted
    )
  }

  finish(operation: PrefetchOperation): void {
    if (this.active === operation) this.active = null
  }

  cancelActive(): void {
    if (!this.active) return
    this.generation++
    this.active.abort.abort()
    this.active = null
  }

  release(): void {
    this.generation++
    this.active?.abort.abort()
    this.active = null
    this.cached = null
  }
}
