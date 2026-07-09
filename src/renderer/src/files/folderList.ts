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

/**
 * Case-insensitive substring filter over "<relDir>/<name>". An empty (or
 * all-whitespace) query keeps the input list identity, so callers keyed on
 * the array (regionExportView's cache, React deps) see no change.
 */
export function filterEntries(files: FolderEntry[], query: string): FolderEntry[] {
  const q = query.trim().toLowerCase()
  if (q === '') return files
  return files.filter((f) => `${f.relDir}/${f.name}`.toLowerCase().includes(q))
}

/** Whether `p` is `root` or sits beneath it. Safe for filesystem roots
 * ('/', drive roots), where naively appending a separator doubles it. */
export function isUnderRoot(root: string, p: string): boolean {
  if (p === root) return true
  const r = root.endsWith('/') || root.endsWith('\\') ? root.slice(0, -1) : root
  return p.startsWith(r + '/') || p.startsWith(r + '\\')
}

/** Split a file name into stem and a '.nii' / '.nii.gz' / plain '.gz' badge
 * (case-insensitive). Must derive the same stem as exportRegions.ts#
 * exportBaseName: regionExportView matches products to sources by stem, so
 * a "<stem>.regions.nii.gz" written from "<stem>.gz" folds into its row. */
export function splitDisplayName(name: string): { stem: string; ext: string } {
  const m = /(\.nii(\.gz)?|\.gz)$/i.exec(name)
  if (!m) return { stem: name, ext: '' }
  return { stem: name.slice(0, m.index), ext: m[0].toLowerCase() }
}

/**
 * Stem of the volume a region-export product was written from, or null for
 * any other name. Products are named "<stem>.regions.<fmt>" / "<stem>.mask.<fmt>"
 * plus '-1', '-2', … collision suffixes (see main's uniquePath).
 */
export function regionExportSource(name: string): string | null {
  const m = /\.(regions|mask)(-\d+)?\.nii(\.gz)?$/i.exec(name)
  return m ? name.slice(0, m.index) : null
}

export interface RegionExportView {
  /** The list with recognized export products hidden. */
  files: FolderEntry[]
  /** Paths of entries that have an export product beside them. */
  exportedFor: ReadonlySet<string>
}

const viewCache = new WeakMap<FolderEntry[], RegionExportView>()

/**
 * Fold region-export products into the list they sit in: a product whose
 * source volume is present in the same directory is hidden and marks that
 * source as exported; a product without its source stays a plain entry (it
 * may be pre-existing data, not something this app wrote). Cached per input
 * array — the store only ever swaps the whole (sorted) list.
 */
export function regionExportView(files: FolderEntry[]): RegionExportView {
  const cached = viewCache.get(files)
  if (cached) return cached
  // Same-directory stem lookup; case-insensitive to match the common
  // case-insensitive filesystems the files sit on.
  const keyOf = (relDir: string, stem: string): string => `${relDir}\u0000${stem.toLowerCase()}`
  const byStem = new Map<string, string[]>()
  for (const f of files) {
    const key = keyOf(f.relDir, splitDisplayName(f.name).stem)
    const paths = byStem.get(key)
    if (paths) paths.push(f.path)
    else byStem.set(key, [f.path])
  }
  const exportedFor = new Set<string>()
  const visible: FolderEntry[] = []
  for (const f of files) {
    const source = regionExportSource(f.name)
    const sources = source === null ? undefined : byStem.get(keyOf(f.relDir, source))
    if (sources) for (const p of sources) exportedFor.add(p)
    else visible.push(f)
  }
  const view = { files: visible, exportedFor }
  viewCache.set(files, view)
  return view
}
