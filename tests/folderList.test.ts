import { describe, expect, it } from 'vitest'
import {
  adjacentIndex,
  compareNatural,
  groupEntries,
  isUnderRoot,
  regionExportSource,
  regionExportView,
  sortEntries,
  splitDisplayName,
  type FolderEntry
} from '../src/renderer/src/files/folderList'
import { exportBaseName } from '../src/renderer/src/segmentation/exportRegions'

function entry(name: string, relDir = ''): FolderEntry {
  return { name, relDir, path: `/root/${relDir ? relDir + '/' : ''}${name}` }
}

describe('compareNatural', () => {
  it('orders embedded numbers numerically', () => {
    expect(compareNatural('file2.nii', 'file10.nii')).toBeLessThan(0)
    expect(compareNatural('file10.nii', 'file2.nii')).toBeGreaterThan(0)
  })

  it('is case-insensitive', () => {
    expect(compareNatural('ABC', 'abc')).toBe(0)
  })
})

describe('sortEntries', () => {
  it('puts root-level files first, then groups in natural order', () => {
    const sorted = sortEntries([
      entry('b.nii', 'g2/deep'),
      entry('x.nii', 'g10'),
      entry('top.nii'),
      entry('a.nii', 'g2/deep'),
      entry('y.nii', 'g2')
    ])
    expect(sorted.map((f) => `${f.relDir}|${f.name}`)).toEqual([
      '|top.nii',
      'g2|y.nii',
      'g2/deep|a.nii',
      'g2/deep|b.nii',
      'g10|x.nii'
    ])
  })

  it('sorts names naturally within a group', () => {
    const sorted = sortEntries([entry('v10.nii', 'g'), entry('v2.nii', 'g')])
    expect(sorted.map((f) => f.name)).toEqual(['v2.nii', 'v10.nii'])
  })

  it('does not mutate the input', () => {
    const input = [entry('b.nii'), entry('a.nii')]
    sortEntries(input)
    expect(input[0].name).toBe('b.nii')
  })
})

describe('groupEntries', () => {
  it('groups consecutive runs of one relDir', () => {
    const groups = groupEntries([
      entry('top.nii'),
      entry('a.nii', 'g1'),
      entry('b.nii', 'g1'),
      entry('c.nii', 'g2')
    ])
    expect(groups.map((g) => [g.relDir, g.entries.length])).toEqual([
      ['', 1],
      ['g1', 2],
      ['g2', 1]
    ])
  })

  it('returns [] for an empty list', () => {
    expect(groupEntries([])).toEqual([])
  })
})

describe('adjacentIndex', () => {
  const files = [entry('a.nii'), entry('b.nii', 'g'), entry('c.nii', 'g')]

  it('steps forward and backward', () => {
    expect(adjacentIndex(files, files[0].path, 1)).toBe(1)
    expect(adjacentIndex(files, files[2].path, -1)).toBe(1)
  })

  it('does not wrap at either end', () => {
    expect(adjacentIndex(files, files[2].path, 1)).toBeNull()
    expect(adjacentIndex(files, files[0].path, -1)).toBeNull()
  })

  it('enters the list when the current path is unknown or null', () => {
    expect(adjacentIndex(files, null, 1)).toBe(0)
    expect(adjacentIndex(files, null, -1)).toBe(2)
    expect(adjacentIndex(files, '/elsewhere/x.nii', 1)).toBe(0)
    expect(adjacentIndex(files, '/elsewhere/x.nii', -1)).toBe(2)
  })

  it('returns null for an empty list', () => {
    expect(adjacentIndex([], null, 1)).toBeNull()
  })
})

describe('isUnderRoot', () => {
  it('matches the root itself and true descendants only', () => {
    expect(isUnderRoot('/data/set', '/data/set')).toBe(true)
    expect(isUnderRoot('/data/set', '/data/set/a.nii')).toBe(true)
    expect(isUnderRoot('/data/set', '/data/set-other/a.nii')).toBe(false)
    expect(isUnderRoot('/data/set', '/elsewhere/a.nii')).toBe(false)
  })

  it('handles filesystem roots without doubling the separator', () => {
    expect(isUnderRoot('/', '/a.nii')).toBe(true)
    expect(isUnderRoot('C:\\', 'C:\\scans\\a.nii')).toBe(true)
  })
})

describe('splitDisplayName', () => {
  it('splits .nii and .nii.gz', () => {
    expect(splitDisplayName('vol.nii')).toEqual({ stem: 'vol', ext: '.nii' })
    expect(splitDisplayName('vol.nii.gz')).toEqual({ stem: 'vol', ext: '.nii.gz' })
  })

  it('splits a plain .gz to the same stem exportBaseName derives', () => {
    expect(splitDisplayName('vol.gz')).toEqual({ stem: 'vol', ext: '.gz' })
    expect(splitDisplayName('vol.tar.gz')).toEqual({ stem: 'vol.tar', ext: '.gz' })
  })

  it('lowercases the extension badge', () => {
    expect(splitDisplayName('VOL.NII.GZ')).toEqual({ stem: 'VOL', ext: '.nii.gz' })
  })

  it('leaves other names whole', () => {
    expect(splitDisplayName('notes.txt')).toEqual({ stem: 'notes.txt', ext: '' })
  })

  it('derives the same stem as exportBaseName for every name shape', () => {
    // The folder panel folds an export into its source row only when the
    // two derivations agree; "x.gz.nii" is the shape where a chained
    // double-strip used to diverge and mark the wrong row.
    for (const name of ['v.nii', 'v.nii.gz', 'v.gz', 'x.gz.nii', 'a.tar.gz', 'noext']) {
      expect(exportBaseName(name)).toBe(splitDisplayName(name).stem)
    }
  })
})

describe('regionExportSource', () => {
  it('recognizes both product kinds in both formats', () => {
    expect(regionExportSource('vol.regions.nii.gz')).toBe('vol')
    expect(regionExportSource('vol.regions.nii')).toBe('vol')
    expect(regionExportSource('vol.mask.nii.gz')).toBe('vol')
    expect(regionExportSource('vol.mask.nii')).toBe('vol')
  })

  it('recognizes collision suffixes', () => {
    expect(regionExportSource('vol.regions-1.nii.gz')).toBe('vol')
    expect(regionExportSource('vol.mask-12.nii')).toBe('vol')
  })

  it('is case-insensitive', () => {
    expect(regionExportSource('VOL.REGIONS.NII.GZ')).toBe('VOL')
  })

  it('returns null for plain volumes and near misses', () => {
    expect(regionExportSource('vol.nii.gz')).toBeNull()
    expect(regionExportSource('regions.nii')).toBeNull()
    expect(regionExportSource('vol.masks.nii')).toBeNull()
    expect(regionExportSource('vol.mask-x.nii')).toBeNull()
    expect(regionExportSource('vol.regions.txt')).toBeNull()
  })
})

describe('regionExportView', () => {
  it('hides a product and marks its source as exported', () => {
    const files = [entry('a.nii.gz'), entry('a.regions.nii.gz'), entry('b.nii.gz')]
    const view = regionExportView(files)
    expect(view.files.map((f) => f.name)).toEqual(['a.nii.gz', 'b.nii.gz'])
    expect(view.exportedFor.has(files[0].path)).toBe(true)
    expect(view.exportedFor.has(files[2].path)).toBe(false)
  })

  it('marks the source regardless of product kind, suffix, or format', () => {
    for (const product of ['a.mask.nii.gz', 'a.regions-2.nii', 'a.mask.nii']) {
      const files = [entry('a.nii.gz'), entry(product)]
      const view = regionExportView(files)
      expect(view.files.map((f) => f.name)).toEqual(['a.nii.gz'])
      expect(view.exportedFor.has(files[0].path)).toBe(true)
    }
  })

  it('folds a product into a plain .gz source', () => {
    // Exports from "a.gz" are named "a.regions.nii.gz" (exportBaseName
    // strips the plain .gz), so the fold must match across the extensions.
    const files = [entry('a.gz'), entry('a.regions.nii.gz')]
    const view = regionExportView(files)
    expect(view.files.map((f) => f.name)).toEqual(['a.gz'])
    expect(view.exportedFor.has(files[0].path)).toBe(true)
  })

  it('keeps a product without its source visible and unmarked', () => {
    const files = [entry('a.mask.nii.gz'), entry('b.nii.gz')]
    const view = regionExportView(files)
    expect(view.files.map((f) => f.name)).toEqual(['a.mask.nii.gz', 'b.nii.gz'])
    expect(view.exportedFor.size).toBe(0)
  })

  it('matches only within the same directory', () => {
    const files = [entry('a.nii.gz', 'g1'), entry('a.regions.nii.gz', 'g2')]
    const view = regionExportView(files)
    expect(view.files).toHaveLength(2)
    expect(view.exportedFor.size).toBe(0)
  })

  it('matches stems case-insensitively', () => {
    const files = [entry('Vol.nii.gz'), entry('VOL.regions.nii.gz')]
    const view = regionExportView(files)
    expect(view.files.map((f) => f.name)).toEqual(['Vol.nii.gz'])
    expect(view.exportedFor.has(files[0].path)).toBe(true)
  })

  it('marks .nii and .nii.gz sources sharing a stem', () => {
    const files = [entry('a.nii'), entry('a.nii.gz'), entry('a.mask.nii.gz')]
    const view = regionExportView(files)
    expect(view.files.map((f) => f.name)).toEqual(['a.nii', 'a.nii.gz'])
    expect(view.exportedFor.has(files[0].path)).toBe(true)
    expect(view.exportedFor.has(files[1].path)).toBe(true)
  })

  it('does not collide stems across the relDir boundary', () => {
    // relDir 'a' + stem 'b c' vs relDir 'a b' + stem 'c'.
    const files = [entry('b c.nii', 'a'), entry('c.regions.nii', 'a b')]
    const view = regionExportView(files)
    expect(view.files).toHaveLength(2)
    expect(view.exportedFor.size).toBe(0)
  })

  it('returns the cached view for the same input array', () => {
    const files = [entry('a.nii.gz')]
    expect(regionExportView(files)).toBe(regionExportView(files))
  })
})
