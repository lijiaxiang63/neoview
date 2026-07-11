import { describe, expect, it } from 'vitest'
import { resolve } from 'path'
import { volumePathFromArgv } from '../src/main/launchFiles'

describe('launch file arguments', () => {
  it('selects the last supported path and resolves it against the launch directory', () => {
    expect(volumePathFromArgv(['--flag', 'a.nii', 'nested/b.nii.gz'], '/work')).toBe(
      resolve('/work', 'nested/b.nii.gz')
    )
  })

  it('ignores switches and unrelated values', () => {
    expect(volumePathFromArgv(['--open=a.nii', 'notes.txt'], '/work')).toBeNull()
  })
})
