export interface GuideSection {
  title: string
  /** Optional leading paragraph rendered before the term/description list. */
  lead?: string
  entries: { term: string; desc: string }[]
}

/**
 * Pure content for the correction help modal, kept out of the component so it
 * is unit-testable without a DOM (the repo has no jsdom / RTL) and so the modal
 * file only exports a component (Fast Refresh). Data uses neutral vocabulary;
 * the statistical names appear only as the math applied. Every claim mirrors
 * what the correction pipeline actually computes.
 */
export function correctionGuideSections(): GuideSection[] {
  return [
    {
      title: 'Overview',
      lead: 'A stat map holds one statistic value per voxel. Thresholding every voxel independently lets noise cross the threshold somewhere by chance, so some highlighted voxels are false positives. Multiple-comparison correction raises the display threshold so the voxels and clusters shown control a chosen error rate. Only finite, non-zero voxels count as part of the analysis.',
      entries: []
    },
    {
      title: 'Methods',
      entries: [
        {
          term: 'None',
          desc: 'Uncorrected. Thresholds each voxel at your chosen p (α) with no adjustment for how many voxels are tested. Fastest and most lenient — expect some false positives.'
        },
        {
          term: 'Bonferroni (FWE)',
          desc: 'Divides α by the number of tested voxels (m), controlling the family-wise error rate — the chance of even one false positive anywhere. Strict; use when every shown voxel must be trustworthy.'
        },
        {
          term: 'FDR',
          desc: 'Benjamini–Hochberg on the voxel p-values. Controls the false discovery rate — the expected proportion of false positives among the voxels shown (the level here is q). More sensitive than Bonferroni.'
        },
        {
          term: 'Cluster GRF',
          desc: 'Forms clusters at a voxel-level p, then keeps only clusters larger than would occur by chance under a Gaussian-random-field model (Friston 1994). Controls error at the cluster level (α). Suited to spatially extended effects.'
        }
      ]
    },
    {
      title: 'Parameters',
      entries: [
        {
          term: 'Statistic',
          desc: 'How each voxel value becomes a p-value: t, z, F, or an already-computed p-map. Preset from the file header when it carries this information; z needs no extra input.'
        },
        {
          term: 'df / df num / df den',
          desc: 'Degrees of freedom for t (df) and F (numerator / denominator). Read from the header when present; a t or F map without valid degrees of freedom cannot be corrected.'
        },
        {
          term: 'α / q',
          desc: 'The target error rate: the voxel or family-wise level for None and Bonferroni, the FDR level q, or the cluster-level α for Cluster GRF.'
        },
        {
          term: 'Cluster p',
          desc: 'Cluster GRF only. The voxel-level p used to form clusters before they are size-thresholded.'
        },
        {
          term: 'Neighbors',
          desc: 'Voxel adjacency for grouping clusters: 6 (shared faces) or 26 (faces, edges, and corners).'
        },
        {
          term: 'Sided',
          desc: 'Whether both signs count (two-tailed) or only positive values (one-tailed). F is inherently one-sided.'
        },
        {
          term: 'Mask',
          desc: 'Restricts the whole correction — test count, FDR denominator, cluster search volume, and display — to the finite, non-zero voxels of another overlay layer. "Whole map (finite, non-zero)" applies no restriction.'
        },
        {
          term: 'Atlas',
          desc: "Names each cluster's peak region and region overlap from a chosen label atlas. Switching the atlas re-annotates the report without re-running the correction."
        }
      ]
    },
    {
      title: 'Reading the results',
      entries: [
        {
          term: 'Threshold gate',
          desc: 'The cutoff a voxel must reach to be shown, written as |t| ≥ … (or p ≤ … for a p-map).'
        },
        {
          term: 'Voxels survive',
          desc: 'How many voxels pass the correction, after any mask is applied.'
        },
        {
          term: 'Min cluster',
          desc: 'Cluster GRF only. The smallest cluster size kept.'
        },
        {
          term: 'FWHM',
          desc: 'The estimated smoothness per axis (in world units), from the same smoothness estimate that drives the Gaussian-random-field model.'
        },
        {
          term: 'Clusters list',
          desc: 'Each surviving cluster’s size, peak value, peak location, and — with an atlas — region. Click a row to move the crosshair to that peak.'
        },
        {
          term: 'Export corrected map',
          desc: 'Writes the thresholded map (with any mask applied) to disk, plus a companion cluster-report table in CSV form when clusters are present.'
        }
      ]
    },
    {
      title: 'Caveats',
      entries: [
        {
          term: 'Voxel-wise FDR',
          desc: 'FDR here is applied to voxel p-values, not to clusters (topological FDR), so results differ from tools that default to cluster-level FDR.'
        },
        {
          term: 'Bonferroni by voxel count',
          desc: 'Family-wise correction divides α by the number of tested voxels rather than using a random-field peak-height threshold, so it is conservative when the map is spatially smooth.'
        },
        {
          term: 'Single-map smoothness',
          desc: 'Unless the header supplies a smoothness value (dLh), the Cluster GRF model estimates smoothness from the displayed map itself via lag-1 autocorrelation — an approximation of a residual-based estimate.'
        },
        {
          term: 'Header-derived inputs',
          desc: 'Statistic kind, degrees of freedom, and (optionally) smoothness are taken from the file header when present; otherwise set the statistic and degrees of freedom yourself.'
        }
      ]
    }
  ]
}
