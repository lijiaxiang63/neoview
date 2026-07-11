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
    if (rawLine.trim() === '') continue
    const columns = rawLine.split('\t')
    if (columns.length < 6) {
      invalidLines++
      continue
    }
    const id = Number(columns[0])
    const channels = columns.slice(1, 5).map(Number)
    const rawName = columns.slice(5).join('\t')
    const name = escaped ? unescapeName(rawName) : rawName
    if (
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      id > 0xffff ||
      channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255) ||
      name.length === 0
    ) {
      invalidLines++
      continue
    }
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
