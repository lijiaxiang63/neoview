import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { ATLAS_CATALOG } from '../src/renderer/src/stats/atlasCatalog'
import { parseAtlasTable } from '../src/renderer/src/stats/atlasTable'
import { parseVolume } from '../src/renderer/src/volume/parse'

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

describe('bundled atlas resources', () => {
  for (const entry of ATLAS_CATALOG) {
    it(`${entry.id} names every non-zero label in its volume`, () => {
      const volumeBytes = gunzipSync(
        readFileSync(new URL(`../resources/${entry.volumeFile}`, import.meta.url))
      )
      const table = parseAtlasTable(
        readFileSync(new URL(`../resources/${entry.tableFile}`, import.meta.url), 'utf8')
      )
      const volume = parseVolume(entry.volumeFile, exactBuffer(volumeBytes))
      const missing = new Set<number>()
      for (let index = 0; index < volume.raw.length; index++) {
        const id = Math.round(volume.raw[index] * volume.slope + volume.inter)
        if (id !== 0 && !table.has(id)) missing.add(id)
      }
      expect([...missing].sort((a, b) => a - b)).toEqual([])
    })
  }
})
