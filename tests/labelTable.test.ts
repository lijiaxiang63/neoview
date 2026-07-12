import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildColorTable, type Region } from '../src/renderer/src/segmentation/regions'
import { layerTableKey, parseLayerLabelTable } from '../src/renderer/src/slicing/labelTable'

function region(name: string): Region {
  return {
    id: 7,
    name,
    color: '#123abc',
    visible: true,
    voxelCount: 1,
    stats: null
  }
}

describe('layer label table', () => {
  it('parses whitespace-separated names and converts transparency to opacity', () => {
    const parsed = parseLayerLabelTable(
      [
        '# id name channels',
        '0 Unknown 0 0 0 0',
        '1 First-Name 10 20 30 0',
        '2 Name With Spaces 4 5 6 7'
      ].join('\n')
    )

    expect(parsed.invalidLines).toBe(0)
    expect(parsed.table?.get(1)).toEqual({ name: 'First-Name', rgba: [10, 20, 30, 255] })
    expect(parsed.table?.get(2)).toEqual({ name: 'Name With Spaces', rgba: [4, 5, 6, 248] })
  })

  it('validates whitespace-separated background rows before ignoring them', () => {
    const parsed = parseLayerLabelTable(
      ['0 Unknown 0 0 0 0', '0 Broken 0 0 0 300', '1 One 1 2 3 0'].join('\n')
    )

    expect(parsed.invalidLines).toBe(1)
    expect(parsed.table?.get(1)?.name).toBe('One')
  })

  it('parses the bundled FreeSurfer preset', () => {
    const text = readFileSync(
      new URL('../resources/FreeSurferColorLUT.txt', import.meta.url),
      'utf8'
    )
    const parsed = parseLayerLabelTable(text)

    expect(parsed.invalidLines).toBe(0)
    expect(parsed.table?.size).toBeGreaterThan(1000)
    expect(parsed.table?.get(1)?.rgba).toEqual([70, 130, 180, 255])
  })
  it('round-trips exported colors and escaped names', () => {
    const text = buildColorTable([{ value: 3, region: region('left\tright\\line\nnext') }])
    const parsed = parseLayerLabelTable(text)

    expect(parsed.invalidLines).toBe(0)
    expect(parsed.table?.get(3)).toEqual({
      name: 'left\tright\\line\nnext',
      rgba: [0x12, 0x3a, 0xbc, 255]
    })
  })

  it('keeps spaces, ignores invalid rows, and lets the last duplicate win', () => {
    const parsed = parseLayerLabelTable(
      ['1\t1\t2\t3\t4\tfirst name', 'bad', '1\t5\t6\t7\t8\tsecond name'].join('\n')
    )

    expect(parsed.invalidLines).toBe(1)
    expect(parsed.table?.get(1)).toEqual({ name: 'second name', rgba: [5, 6, 7, 8] })
  })

  it('preserves backslash sequences in legacy unmarked files', () => {
    const parsed = parseLayerLabelTable('1\t1\t2\t3\t255\tA\\new\\tab\n')
    expect(parsed.table?.get(1)?.name).toBe('A\\new\\tab')
  })

  it('preserves a legacy name that resembles the new marker', () => {
    const parsed = parseLayerLabelTable('1\t1\t2\t3\t255\t@table-escaped-v1@Target\\name\n')
    expect(parsed.table?.get(1)?.name).toBe('@table-escaped-v1@Target\\name')
  })

  it('matches collision-suffixed companion paths by directory and stem', () => {
    expect(layerTableKey('/out/item.regions-2.nii.gz')).toBe(
      layerTableKey('/out/item.regions-2.txt')
    )
    expect(layerTableKey('/other/item.regions-2.txt')).not.toBe(
      layerTableKey('/out/item.regions-2.nii')
    )
    expect(layerTableKey('/out/Item.txt')).not.toBe(layerTableKey('/out/item.nii'))
    expect(layerTableKey('/out/a\\b.txt')).not.toBe(layerTableKey('/out/a/b.nii'))
    expect(layerTableKey('C:\\OUT\\Item.txt', true)).toBe(layerTableKey('c:/out/item.nii', true))
  })
})
