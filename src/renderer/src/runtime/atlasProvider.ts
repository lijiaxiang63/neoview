// Loads a bundled atlas (label volume + name table) on demand from the main
// process and caches the parsed result. Used to annotate cluster reports with
// region names; the names are runtime data from the resource's .csv.

import type { AtlasResource } from '../../../shared/files'
import { atlasEntry } from '../stats/atlasCatalog'
import type { Atlas } from '../stats/atlasAnnotation'
import { parseAtlasTable } from '../stats/atlasTable'
import { loadVolume } from '../volume/loadVolume'

export interface AtlasBridge {
  readAtlas(requestId: number, atlasId: string): Promise<AtlasResource | null>
}

export class AtlasProvider {
  private readonly cache = new Map<string, Promise<Atlas | null>>()
  private readonly resolved = new Map<string, Atlas>()
  private nextRequestId = 1

  constructor(private readonly bridge: AtlasBridge) {}

  /** Parsed atlas for `id`, loaded and cached on first request; null if unknown
   * or if loading fails. */
  get(id: string): Promise<Atlas | null> {
    let pending = this.cache.get(id)
    if (!pending) {
      pending = this.load(id)
        .then((atlas) => {
          if (atlas) this.resolved.set(id, atlas)
          return atlas
        })
        .catch(() => null)
      this.cache.set(id, pending)
    }
    return pending
  }

  /** Already-loaded atlas for `id`, or null if not loaded yet. Synchronous so a
   * recompute can embed the atlas in its request without awaiting. */
  getCached(id: string): Atlas | null {
    return this.resolved.get(id) ?? null
  }

  private async load(id: string): Promise<Atlas | null> {
    const spec = atlasEntry(id)
    if (!spec) return null
    const resource = await this.bridge.readAtlas(this.nextRequestId++, id)
    if (!resource) return null
    const volume = await loadVolume(spec.volumeFile, resource.bytes, {
      skipTex: true,
      signal: new AbortController().signal
    })
    return { volume, names: parseAtlasTable(resource.table) }
  }

  dispose(): void {
    this.cache.clear()
    this.resolved.clear()
  }
}

/** Construct a provider bound to the preload bridge, or null when it is
 * unavailable (tests / non-renderer contexts). */
export function createAtlasProvider(): AtlasProvider | null {
  const bridge = typeof window !== 'undefined' ? window.neoview : undefined
  return bridge && typeof bridge.readAtlas === 'function' ? new AtlasProvider(bridge) : null
}
