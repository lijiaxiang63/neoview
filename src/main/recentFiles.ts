/** Pure list operations behind the File > Open Recent menu (persistence and
 * menu wiring live in main/index.ts). Most-recent-first, deduplicated, capped. */

export const RECENT_MAX = 10

export function addRecent(list: readonly string[], path: string, max = RECENT_MAX): string[] {
  if (!path) return [...list]
  return [path, ...list.filter((p) => p !== path)].slice(0, max)
}

export function removeRecent(list: readonly string[], path: string): string[] {
  return list.filter((p) => p !== path)
}

/** Parse the persisted JSON payload; anything malformed yields an empty list. */
export function parseRecentPayload(text: string, max = RECENT_MAX): string[] {
  try {
    const data: unknown = JSON.parse(text)
    if (typeof data !== 'object' || data === null) return []
    const files = (data as { files?: unknown }).files
    if (!Array.isArray(files)) return []
    return files.filter((p): p is string => typeof p === 'string' && p.length > 0).slice(0, max)
  } catch {
    return []
  }
}

export function serializeRecentPayload(list: readonly string[]): string {
  return JSON.stringify({ files: list }, null, 2)
}

/**
 * Display labels for the menu: the file name alone, except when several
 * entries share one name — those get "name — parent" so they stay tellable
 * apart.
 */
export function recentLabels(list: readonly string[]): string[] {
  const nameOf = (p: string): string => p.split(/[\\/]/).pop() ?? p
  const parentOf = (p: string): string => {
    const parts = p.split(/[\\/]/)
    return parts.length > 1 ? parts[parts.length - 2] : ''
  }
  const counts = new Map<string, number>()
  for (const p of list) {
    const n = nameOf(p)
    counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  return list.map((p) => {
    const n = nameOf(p)
    const parent = parentOf(p)
    return (counts.get(n) ?? 0) > 1 && parent ? `${n} — ${parent}` : n
  })
}
