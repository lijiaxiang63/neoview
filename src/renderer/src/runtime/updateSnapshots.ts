import type { UpdateSnapshot, UpdateState } from '../../../shared/updates'

export const INITIAL_UPDATE_SNAPSHOT: UpdateSnapshot = {
  revision: -1,
  commandId: -1,
  state: { phase: 'idle' }
}

/** Keep the newest application-owned snapshot regardless of whether it
 * arrived through the live event or the initial query. */
export function newestUpdateSnapshot(
  current: UpdateSnapshot,
  incoming: UpdateSnapshot
): UpdateSnapshot {
  return incoming.revision >= current.revision ? incoming : current
}

/** Per-subscription lifetime gate. Late query completions become inert after
 * unmount, while event/query ordering is resolved by the monotonic revision. */
export class UpdateSnapshotReceiver {
  private current = INITIAL_UPDATE_SNAPSHOT
  private active = true

  accept(incoming: UpdateSnapshot): UpdateSnapshot | null {
    if (!this.active) return null
    const next = newestUpdateSnapshot(this.current, incoming)
    if (next === this.current) return null
    this.current = next
    return next
  }

  dispose(): void {
    this.active = false
  }
}

/** Synchronous renderer-side latch for one command card. It closes the gap
 * between a click and the next authoritative snapshot, and token ownership
 * prevents an older async completion from releasing a newer command. */
export class UpdateCommandLatch {
  private nextToken = 0
  private activeToken: number | null = null

  begin(): number | null {
    if (this.activeToken !== null) return null
    this.activeToken = ++this.nextToken
    return this.activeToken
  }

  release(token: number): boolean {
    if (token !== this.activeToken) return false
    this.activeToken = null
    return true
  }

  owns(token: number): boolean {
    return token === this.activeToken
  }

  reset(): boolean {
    if (this.activeToken === null) return false
    this.activeToken = null
    return true
  }

  isPending(): boolean {
    return this.activeToken !== null
  }
}

export interface UpdateCommandOwner {
  token: number
  revision: number
  commandId: number
}

export function updateResultAutoDismisses(state: UpdateState): boolean {
  return state.phase === 'none' || state.phase === 'error' || state.phase === 'saved'
}

/** Build a local transport fallback only while the originating click still
 * owns both the latch and the exact application snapshot. */
export function ownedUpdateFallback(
  current: UpdateSnapshot,
  owner: UpdateCommandOwner,
  latch: UpdateCommandLatch,
  state: UpdateState
): UpdateSnapshot | null {
  if (
    !latch.owns(owner.token) ||
    current.revision !== owner.revision ||
    current.commandId !== owner.commandId
  ) {
    return null
  }
  return { ...current, state }
}
