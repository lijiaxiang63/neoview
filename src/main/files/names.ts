/** File-name checks shared by pickers, scans, reads, and document-open events. */
export function isVolumeFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.nii') || lower.endsWith('.nii.gz')
}

/** Keep in step with the renderer's folding of export products. */
export function isRegionExportFileName(name: string): boolean {
  return /\.(regions|mask)(-\d+)?(\.nii\.gz|\.nii)$/i.test(name)
}
