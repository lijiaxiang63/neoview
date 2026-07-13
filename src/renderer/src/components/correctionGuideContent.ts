export interface GuideTable {
  /** Header cells; the first column labels each row's aspect. */
  columns: [string, string, string]
  rows: [string, string, string][]
}

export interface GuideSection {
  title: string
  /** Optional leading paragraph rendered before any list or table. */
  lead?: string
  entries?: { term: string; desc: string }[]
  table?: GuideTable
}

/**
 * Pure content for the correction help modal, kept out of the component so it
 * is unit-testable without a DOM (the repo has no jsdom / RTL) and so the modal
 * file only exports a component (Fast Refresh). Data uses neutral vocabulary;
 * the statistical names appear only as the math applied. The method / parameter
 * claims mirror what this pipeline computes; the comparison column states the
 * standard behavior of the reference package (SPM).
 */
export function correctionGuideSections(): GuideSection[] {
  return [
    {
      title: 'Overview',
      lead: 'A stat map holds one value per voxel; thresholding every voxel lets noise pass somewhere by chance. Correction raises the display threshold to control a chosen error rate. Only finite, non-zero voxels are tested.',
      entries: []
    },
    {
      title: 'Methods',
      entries: [
        { term: 'None', desc: 'Per-voxel threshold at p = α. No multiplicity control.' },
        {
          term: 'Bonferroni (FWE)',
          desc: 'α ÷ tested-voxel count. Controls the chance of any false positive. Strict.'
        },
        {
          term: 'FDR',
          desc: 'Benjamini–Hochberg on voxel p-values. Controls the expected false-positive proportion among voxels shown (level q).'
        },
        {
          term: 'Cluster GRF',
          desc: 'Threshold at a voxel p, then keep clusters larger than chance under a Gaussian random field (Friston 1994). Cluster-level α.'
        }
      ]
    },
    {
      title: 'This viewer vs SPM',
      lead: 'This viewer works from one stat map plus its header, so a few choices SPM derives from the full model are approximated here.',
      table: {
        columns: ['', 'This viewer', 'SPM'],
        rows: [
          ['Voxel FWE', 'Bonferroni (α ÷ voxel count)', 'Random-field peak height'],
          ['FDR', 'Voxel-wise Benjamini–Hochberg', 'Topological (peak / cluster-level)'],
          [
            'Cluster extent',
            'Gaussian random field, Friston 1994',
            'Gaussian random field (same family)'
          ],
          ['Smoothness', 'From this map, or header dLh', 'From model residuals'],
          ['Inputs', 'Stat map + header only', 'Full model (design + residuals)']
        ]
      }
    },
    {
      title: 'Parameters',
      entries: [
        {
          term: 'Statistic',
          desc: 't / z / F / p. Preset from the header; z needs no degrees of freedom.'
        },
        { term: 'df / df num / df den', desc: 'Degrees of freedom for t / F, from the header.' },
        { term: 'α / q', desc: 'Target error rate; q is the FDR level.' },
        { term: 'Cluster p', desc: 'Voxel p used to form clusters (Cluster GRF).' },
        {
          term: 'Neighbors',
          desc: 'Cluster adjacency: 6 (faces) or 26 (faces + edges + corners).'
        },
        { term: 'Sided', desc: 'Two-tailed or positive-only. F and p do not use this setting.' },
        { term: 'Mask', desc: "Restrict correction to another layer's finite, non-zero voxels." },
        {
          term: 'Atlas',
          desc: "Name each cluster's peak region; switching re-annotates without recomputing."
        }
      ]
    },
    {
      title: 'Reading the results',
      entries: [
        { term: 'Threshold gate', desc: 'Cutoff to be shown: |t| ≥ … (or p ≤ … for a p-map).' },
        { term: 'Voxels survive', desc: 'Count passing after correction and any mask.' },
        { term: 'Min cluster', desc: 'Smallest cluster kept (Cluster GRF).' },
        {
          term: 'FWHM',
          desc: 'Estimated smoothness per axis in world units, from the same estimate that drives the model.'
        },
        {
          term: 'Clusters list',
          desc: 'Size, peak, location, and — with an atlas — region. Click a row to jump the crosshair.'
        },
        {
          term: 'Export corrected map',
          desc: 'Writes the thresholded map, plus a cluster-report CSV when clusters are present.'
        }
      ]
    }
  ]
}
