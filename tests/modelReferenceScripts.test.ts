import { describe, expect, it } from 'vitest'
import {
  MODEL_AUTOMATION_VARIANTS,
  modelReferenceSampleKey,
  parseModelAutomationArgs
} from '../scripts/run-model-reference.mjs'
import { parseUpstreamAutomationArgs } from '../scripts/run-upstream-model-reference.mjs'

describe('model reference scripts', () => {
  it('enumerates every selectable variant and supports targeted jobs', () => {
    expect(MODEL_AUTOMATION_VARIANTS).toHaveLength(14)
    const parsed = parseModelAutomationArgs([
      '--output',
      '/tmp/output',
      '--force',
      '--variant',
      'aparc-104-low',
      '/tmp/input.nii.gz'
    ])
    expect(parsed.force).toBe(true)
    expect(parsed.jobs).toEqual([
      {
        inputPath: '/tmp/input.nii.gz',
        variant: { id: 'aparc-104-low', groupId: 'aparc-104' }
      }
    ])
  })

  it('keeps same-named inputs in different folders isolated', () => {
    const first = modelReferenceSampleKey('/tmp/one/input.nii.gz')
    const second = modelReferenceSampleKey('/tmp/two/input.nii.gz')
    expect(first).not.toBe(second)
    expect(first).toMatch(/^input-[a-f0-9]{12}$/)
  })

  it('forwards fixed-source and job arguments independently', () => {
    const parsed = parseUpstreamAutomationArgs([
      '--source',
      '/tmp/source',
      '--output',
      '/tmp/output',
      '--default',
      '/tmp/input.nii.gz'
    ])
    expect(parsed.source).toBe('/tmp/source')
    expect(parsed.jobs).toHaveLength(1)
    expect(parsed.jobs[0].variant.id).toBe('tissue-high')
  })
})
