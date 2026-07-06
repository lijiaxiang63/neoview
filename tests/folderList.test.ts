import { describe, expect, it } from 'vitest'
import {
  adjacentIndex,
  compareNatural,
  groupEntries,
  isUnderRoot,
  sortEntries,
  splitDisplayName,
  type FolderEntry
} from '../src/renderer/src/files/folderList'

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

  it('lowercases the extension badge', () => {
    expect(splitDisplayName('VOL.NII.GZ')).toEqual({ stem: 'VOL', ext: '.nii.gz' })
  })

  it('leaves other names whole', () => {
    expect(splitDisplayName('notes.txt')).toEqual({ stem: 'notes.txt', ext: '' })
  })
})
