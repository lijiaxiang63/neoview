// The bundled reference atlases available for cluster-report region annotation.
// Each `id` is the wire name passed to the main process to read the resource;
// `label` is the UI selector text; the files live under `resources/`. Region
// names come from the .csv table at runtime (see atlasTable.ts) — none are
// authored here.

export interface AtlasEntry {
  id: string
  label: string
  volumeFile: string
  tableFile: string
}

export const ATLAS_CATALOG: AtlasEntry[] = [
  { id: 'aal3', label: 'AAL3', volumeFile: 'aal3.nii.gz', tableFile: 'aal3.csv' },
  {
    id: 'neuromorphometrics',
    label: 'Neuromorphometrics',
    volumeFile: 'neuromorphometrics.nii.gz',
    tableFile: 'neuromorphometrics.csv'
  },
  { id: 'suit', label: 'SUIT', volumeFile: 'suit.nii.gz', tableFile: 'suit.csv' },
  {
    id: 'thalamic_nuclei',
    label: 'Thalamic nuclei',
    volumeFile: 'thalamic_nuclei.nii.gz',
    tableFile: 'thalamic_nuclei.csv'
  },
  {
    id: 'tian_subcortex_s4',
    label: 'Tian subcortex S4',
    volumeFile: 'Tian_Subcortex_S4_7T.nii.gz',
    tableFile: 'Tian_Subcortex_S4_7T.csv'
  }
]

export function atlasEntry(id: string): AtlasEntry | undefined {
  return ATLAS_CATALOG.find((entry) => entry.id === id)
}
