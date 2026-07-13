// Parses a bundled atlas name table (a ';'-delimited CSV with a header row that
// includes ROIid and ROIname columns) into a label-id → region-name map. The
// region names are runtime data from the resource, never authored here. Pure.

/** Map atlas label ids to region names from the CSV text. Returns an empty map
 * when the header lacks the expected columns. */
export function parseAtlasTable(csv: string): Map<number, string> {
  const names = new Map<number, string>()
  const lines = csv.split(/\r?\n/)
  let headerSeen = false
  let idCol = -1
  let nameCol = -1
  for (const line of lines) {
    if (line.trim() === '') continue
    const cols = line.split(';')
    if (!headerSeen) {
      headerSeen = true
      const header = cols.map((h) => h.trim().toLowerCase())
      idCol = header.indexOf('roiid')
      nameCol = header.indexOf('roiname')
      if (idCol === -1 || nameCol === -1) return names
      continue
    }
    if (cols.length <= Math.max(idCol, nameCol)) continue
    const idText = cols[idCol].trim()
    if (idText === '') continue // an empty id cell would parse as 0 (background)
    const id = Number(idText)
    const name = cols[nameCol].trim()
    if (Number.isInteger(id) && name) names.set(id, name)
  }
  return names
}
