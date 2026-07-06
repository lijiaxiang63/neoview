/** One volume file found while scanning an opened folder. */
export interface FolderEntry {
  name: string
  path: string
  /** Directory relative to the scanned root, '/'-joined; '' for the root itself. */
  relDir: string
}

export interface FileGroup {
  relDir: string
  entries: FolderEntry[]
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function compareNatural(a: string, b: string): number {
  return collator.compare(a, b)
}

/** Root-level files first, then groups in natural relDir order, names natural within a group. */
export function sortEntries(files: FolderEntry[]): FolderEntry[] {
  return [...files].sort((a, b) => {
    if (a.relDir !== b.relDir) {
      if (a.relDir === '') return -1
      if (b.relDir === '') return 1
      return compareNatural(a.relDir, b.relDir)
    }
    return compareNatural(a.name, b.name)
  })
}

/** Consecutive runs of one relDir over an already-sorted list. */
export function groupEntries(files: FolderEntry[]): FileGroup[] {
  const groups: FileGroup[] = []
  for (const f of files) {
    const last = groups[groups.length - 1]
    if (last && last.relDir === f.relDir) last.entries.push(f)
    else groups.push({ relDir: f.relDir, entries: [f] })
  }
  return groups
}

/**
 * Index of the file `delta` steps from currentPath; null when the move falls
 * off either end (no wrap) or the list is empty. A path not in the list means
 * "enter the list": delta > 0 → first file, delta < 0 → last file.
 */
export function adjacentIndex(
  files: FolderEntry[],
  currentPath: string | null,
  delta: 1 | -1
): number | null {
  if (files.length === 0) return null
  const cur = currentPath === null ? -1 : files.findIndex((f) => f.path === currentPath)
  if (cur === -1) return delta > 0 ? 0 : files.length - 1
  const next = cur + delta
  return next >= 0 && next < files.length ? next : null
}

/** Whether `p` is `root` or sits beneath it. Safe for filesystem roots
 * ('/', drive roots), where naively appending a separator doubles it. */
export function isUnderRoot(root: string, p: string): boolean {
  if (p === root) return true
  const r = root.endsWith('/') || root.endsWith('\\') ? root.slice(0, -1) : root
  return p.startsWith(r + '/') || p.startsWith(r + '\\')
}

/** Split a file name into stem and a '.nii' / '.nii.gz' badge (case-insensitive). */
export function splitDisplayName(name: string): { stem: string; ext: string } {
  const m = /\.nii(\.gz)?$/i.exec(name)
  if (!m) return { stem: name, ext: '' }
  return { stem: name.slice(0, m.index), ext: m[0].toLowerCase() }
}
