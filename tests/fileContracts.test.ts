import { describe, expect, it } from 'vitest'
import { FILE_CHANNELS, parseExportRequest } from '../src/shared/files'

describe('file process contracts', () => {
  it('keeps channel names centralized and parses an export payload', () => {
    const bytes = new ArrayBuffer(2)
    expect(new Set(Object.values(FILE_CHANNELS)).size).toBe(Object.keys(FILE_CHANNELS).length)
    expect(
      parseExportRequest({
        dir: '/out',
        fileName: 'a.nii',
        bytes,
        sidecar: { fileName: 'a.txt', text: 'x' }
      })
    ).toEqual({
      dir: '/out',
      fileName: 'a.nii',
      bytes,
      sidecar: { fileName: 'a.txt', text: 'x' }
    })
  })

  it('rejects malformed values before they reach the export service', () => {
    expect(() => parseExportRequest(null)).toThrow('Invalid export request')
    expect(() =>
      parseExportRequest({ dir: '/out', fileName: 'a.nii', bytes: 'bad', sidecar: null })
    ).toThrow('Invalid export request')
    expect(() =>
      parseExportRequest({
        dir: '/out',
        fileName: 'a.nii',
        bytes: new ArrayBuffer(0),
        sidecar: { fileName: 'a.txt', text: 1 }
      })
    ).toThrow('Invalid export request')
  })
})
