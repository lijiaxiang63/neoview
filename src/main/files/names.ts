/** File-name checks shared by pickers, scans, reads, and document-open events. */
export function isVolumeFileName(name: string): boolean {
  const lower = name.toLowerCase()
  // Plain .gz is accepted to match the open dialog's filter — the loader
  // detects gzip by signature, so the inner payload decides validity.
  return lower.endsWith('.nii') || lower.endsWith('.gz')
}

/** Keep in step with the renderer's folding of export products. */
export function isRegionExportFileName(name: string): boolean {
  return /\.(regions|mask)(-\d+)?\.nii(\.gz)?$/i.test(name)
}
