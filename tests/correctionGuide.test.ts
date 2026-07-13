import { describe, expect, it } from 'vitest'
import { correctionGuideSections } from '../src/renderer/src/components/correctionGuideContent'

describe('correctionGuideSections', () => {
  const sections = correctionGuideSections()
  const byTitle = (t: string): ReturnType<typeof correctionGuideSections>[number] | undefined =>
    sections.find((s) => s.title === t)
  const terms = (t: string): string[] => byTitle(t)?.entries.map((e) => e.term) ?? []
  const descs = (t: string): string[] => byTitle(t)?.entries.map((e) => e.desc) ?? []

  it('exposes the expected top-level sections in order', () => {
    expect(sections.map((s) => s.title)).toEqual([
      'Overview',
      'Methods',
      'Parameters',
      'Reading the results',
      'Caveats'
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
    // The mask description names what it restricts, so it stays in sync with the feature.
    const mask = byTitle('Parameters')?.entries.find((e) => e.term === 'Mask')?.desc ?? ''
    expect(mask.toLowerCase()).toContain('non-zero voxels')
  })

  it('surfaces the honest methodological caveats', () => {
    const t = terms('Caveats')
    expect(t.length).toBeGreaterThanOrEqual(3)
    const all = descs('Caveats').join(' ').toLowerCase()
    expect(all).toContain('topological') // voxel-wise FDR vs topological FDR
    expect(all).toContain('smoothness') // single-map smoothness approximation
  })

  it('gives every non-overview section at least one entry', () => {
    for (const s of sections) {
      if (s.title === 'Overview') continue
      expect(s.entries.length).toBeGreaterThan(0)
    }
  })

  it('never emits a blank term or description', () => {
    for (const s of sections) {
      for (const e of s.entries) {
        expect(e.term.trim().length).toBeGreaterThan(0)
        expect(e.desc.trim().length).toBeGreaterThan(0)
      }
    }
  })
})
