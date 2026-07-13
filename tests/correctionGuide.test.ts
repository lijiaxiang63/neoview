import { describe, expect, it } from 'vitest'
import { correctionGuideSections } from '../src/renderer/src/components/correctionGuideContent'

describe('correctionGuideSections', () => {
  const sections = correctionGuideSections()
  const byTitle = (t: string): ReturnType<typeof correctionGuideSections>[number] | undefined =>
    sections.find((s) => s.title === t)
  const terms = (t: string): string[] => byTitle(t)?.entries?.map((e) => e.term) ?? []

  it('exposes the expected top-level sections in order', () => {
    expect(sections.map((s) => s.title)).toEqual([
      'Overview',
      'Methods',
      'This viewer vs SPM',
      'Parameters',
      'Reading the results'
    ])
  })

  it('opens with a non-empty lead paragraph on the overview', () => {
    const overview = byTitle('Overview')
    expect(overview?.lead && overview.lead.length).toBeGreaterThan(40)
    expect(overview?.entries).toHaveLength(0)
  })

  it('covers all four correction methods', () => {
    const t = terms('Methods')
    expect(t).toContain('None')
    expect(t.some((x) => x.includes('Bonferroni'))).toBe(true)
    expect(t).toContain('FDR')
    expect(t.some((x) => x.includes('Cluster') || x.includes('GRF'))).toBe(true)
  })

  it('documents the mask and atlas parameters', () => {
    const t = terms('Parameters')
    expect(t).toContain('Mask')
    expect(t).toContain('Atlas')
    const mask = byTitle('Parameters')?.entries?.find((e) => e.term === 'Mask')?.desc ?? ''
    expect(mask.toLowerCase()).toContain('non-zero voxels')
  })

  it('compares this viewer against SPM in a well-formed table', () => {
    const table = byTitle('This viewer vs SPM')?.table
    expect(table).toBeDefined()
    expect(table?.columns).toEqual(['', 'This viewer', 'SPM'])
    // Every row is a full triple with no blank cell beyond the header slot.
    for (const row of table?.rows ?? []) {
      expect(row).toHaveLength(3)
      for (const cell of row) expect(cell.trim().length).toBeGreaterThan(0)
    }
    // The differences the table must convey (accuracy anchors vs the code + SPM).
    const flat = (table?.rows ?? []).flat().join(' ').toLowerCase()
    expect(flat).toContain('bonferroni')
    expect(flat).toContain('benjamini') // voxel-wise FDR
    expect(flat).toContain('topological') // SPM's FDR
    expect(flat).toContain('residual') // SPM's smoothness source
  })

  it('gives every non-overview section either entries or a table', () => {
    for (const s of sections) {
      if (s.title === 'Overview') continue
      const hasEntries = (s.entries?.length ?? 0) > 0
      const hasTable = (s.table?.rows.length ?? 0) > 0
      expect(hasEntries || hasTable).toBe(true)
    }
  })

  it('never emits a blank term or description', () => {
    for (const s of sections) {
      for (const e of s.entries ?? []) {
        expect(e.term.trim().length).toBeGreaterThan(0)
        expect(e.desc.trim().length).toBeGreaterThan(0)
      }
    }
  })
})
