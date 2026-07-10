import { isAbsolute, relative, resolve, sep } from 'path'
import { isVolumeFileName } from './names'

export interface FileAccessDependencies {
  realpath(path: string): Promise<string>
}

export interface ScanAccessRequest {
  readonly ownerId: number
  readonly requestId: number
}

export interface PreparedScanAccess extends ScanAccessRequest {
  readonly realRoot: string
}

export interface AuthorizedReadPath {
  /** Renderer-visible path identity. */
  requestedPath: string
  /** Resolved target that passed containment validation and must be read. */
  realPath: string
}

interface OwnerAccess {
  requestId: number
  realRoot: string | null
  /** Root active before this request; used if an unseen batch loses a cancel race. */
  fallbackRoot: string | null
}

/** True only when candidate is root itself or a real descendant, not a similar prefix. */
export function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Per-webContents authorization with monotonic request generations. */
export class FileAccessAuthorizer {
  private readonly deps: FileAccessDependencies
  private readonly owners = new Map<number, OwnerAccess>()
  private nextRequestId = 0

  constructor(deps: FileAccessDependencies) {
    this.deps = deps
  }

  /** Start a scan intent without disturbing the currently displayed root. */
  beginScan(ownerId: number): ScanAccessRequest {
    const requestId = ++this.nextRequestId
    const current = this.owners.get(ownerId)
    const realRoot = current?.realRoot ?? null
    this.owners.set(ownerId, { requestId, realRoot, fallbackRoot: realRoot })
    return { ownerId, requestId }
  }

  /** Resolve a selected root, retaining the request generation across the await. */
  async prepareScan(request: ScanAccessRequest, path: string): Promise<PreparedScanAccess | null> {
    const realRoot = await this.deps.realpath(resolve(path))
    if (!this.isCurrent(request)) return null
    return { ...request, realRoot }
  }

  /** Replace access immediately before the first result becomes visible. */
  activateScan(prepared: PreparedScanAccess): boolean {
    if (!this.isCurrent(prepared)) return false
    this.owners.set(prepared.ownerId, {
      requestId: prepared.requestId,
      realRoot: prepared.realRoot,
      fallbackRoot: this.owners.get(prepared.ownerId)?.fallbackRoot ?? null
    })
    return true
  }

  isCurrent(request: ScanAccessRequest): boolean {
    return this.owners.get(request.ownerId)?.requestId === request.requestId
  }

  /** The renderer accepted this scan; its root is now the only rollback target. */
  confirmScan(request: ScanAccessRequest): boolean {
    const current = this.owners.get(request.ownerId)
    if (current?.requestId !== request.requestId) return false
    this.owners.set(request.ownerId, { ...current, fallbackRoot: current.realRoot })
    return true
  }

  /** Supersede an in-flight scan, rolling an unconfirmed candidate back. */
  cancelScan(ownerId: number): void {
    const current = this.owners.get(ownerId)
    const realRoot = current?.fallbackRoot ?? current?.realRoot ?? null
    this.owners.set(ownerId, {
      requestId: ++this.nextRequestId,
      realRoot,
      fallbackRoot: realRoot
    })
  }

  /** Drop both active access and every pending request for this owner. */
  release(ownerId: number): void {
    this.owners.delete(ownerId)
  }

  async authorizeRead(ownerId: number, path: unknown): Promise<AuthorizedReadPath> {
    if (typeof path !== 'string' || !isVolumeFileName(path)) {
      throw new Error('Not a .nii or .nii.gz file.')
    }
    const requestedPath = resolve(path)
    const realPath = await this.deps.realpath(requestedPath).catch(() => null)
    const root = this.owners.get(ownerId)?.realRoot ?? null
    if (realPath === null || root === null || !isPathWithin(root, realPath)) {
      throw new Error('File is outside the opened folder.')
    }
    return { requestedPath, realPath }
  }

  /** Test/diagnostic view; returns no mutable internal state. */
  activeRoot(ownerId: number): string | null {
    return this.owners.get(ownerId)?.realRoot ?? null
  }
}
