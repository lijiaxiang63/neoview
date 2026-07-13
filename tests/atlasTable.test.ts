import { describe, expect, it } from 'vitest'
import { parseAtlasTable } from '../src/renderer/src/stats/atlasTable'

describe('parseAtlasTable', () => {
  it('reads ROIid → ROIname with the name in a middle column', () => {
    const csv =
      'ROIid;ROIabbr;ROIname;ROIcolor\n1;lPreCG;Left Precentral gyrus;203 142 203\n2;rPreCG;Right Precentral gyrus;203 142 203\n'
    const names = parseAtlasTable(csv)
    expect(names.get(1)).toBe('Left Precentral gyrus')
    expect(names.get(2)).toBe('Right Precentral gyrus')
    expect(names.size).toBe(2)
  })

  it('reads a two-column table (ROIid;ROIname)', () => {
    const names = parseAtlasTable('ROIid;ROIname\n1;Left I IV\n2;Right I IV')
    expect(names.get(1)).toBe('Left I IV')
    expect(names.get(2)).toBe('Right I IV')
  })

  it('finds ROIname regardless of column order', () => {
    const names = parseAtlasTable('ROIid;ROIname;Vgm;Vwm\n4;3rd Ventricle;0;0')
    expect(names.get(4)).toBe('3rd Ventricle')
  })

  it('returns empty when the header lacks the expected columns', () => {
    expect(parseAtlasTable('a;b\n1;x').size).toBe(0)
    expect(parseAtlasTable('').size).toBe(0)
  })

  it('skips malformed rows', () => {
    const names = parseAtlasTable('ROIid;ROIname\n1;Region A\nnot-a-number;X\n;empty\n3;Region C')
    expect(names.get(1)).toBe('Region A')
    expect(names.get(3)).toBe('Region C')
    expect(names.size).toBe(2)
  })
})
