export interface LayerLabelEntry {
  name: string
  rgba: readonly [number, number, number, number]
}

export type LayerLabelTable = ReadonlyMap<number, LayerLabelEntry>

export interface LayerLabelTableParseResult {
  table: LayerLabelTable | null
  invalidLines: number
}

export const ESCAPED_LAYER_TABLE_MARKER_ROW = '0\t0\t0\t0\t0\t@table-escaped-v1@'

function unescapeName(value: string): string {
  return value.replace(/\\([\\tnr])/g, (_match, escaped: string) => {
    if (escaped === 't') return '\t'
    if (escaped === 'n') return '\n'
    if (escaped === 'r') return '\r'
    return '\\'
  })
}

export function escapeLayerLabelName(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
}

export function parseLayerLabelTable(text: string): LayerLabelTableParseResult {
  const table = new Map<number, LayerLabelEntry>()
  let invalidLines = 0
  const lines = text.split(/\r?\n/)
  const escaped = lines[0] === ESCAPED_LAYER_TABLE_MARKER_ROW
  for (let lineIndex = escaped ? 1 : 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex]
    const trimmed = rawLine.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const columns = rawLine.split('\t')
    const native =
      columns.length >= 6 &&
      columns.slice(1, 5).every((value) => value.trim() !== '' && Number.isFinite(Number(value)))
    let id: number
    let channels: number[]
    let name: string
    if (native) {
      id = Number(columns[0])
      channels = columns.slice(1, 5).map(Number)
      const rawName = columns.slice(5).join('\t')
      name = escaped ? unescapeName(rawName) : rawName
    } else {
      const match = trimmed.match(/^(\S+)\s+(.+?)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/)
      if (!match) {
        invalidLines++
        continue
      }
      id = Number(match[1])
      name = match[2]
      const values = match.slice(3, 7).map(Number)
      channels = [values[0], values[1], values[2], 255 - values[3]]
    }
    const whitespaceBackground = !native && id === 0
    if (
      !Number.isSafeInteger(id) ||
      id < (whitespaceBackground ? 0 : 1) ||
      id > 0xffff ||
      channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255) ||
      name.length === 0
    ) {
      invalidLines++
      continue
    }
    // Zero is the transparent background in this whitespace-separated format.
    if (whitespaceBackground) continue
    table.set(id, {
      name,
      rgba: channels as unknown as readonly [number, number, number, number]
    })
  }
  return { table: table.size > 0 ? table : null, invalidLines }
}

export function layerTableKey(value: string, caseInsensitive = false): string {
  const platformPath = caseInsensitive ? value.replace(/\\/g, '/') : value
  const normalized = platformPath.replace(/(\.nii\.gz|\.nii|\.txt)$/i, '')
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

export function layerFileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
