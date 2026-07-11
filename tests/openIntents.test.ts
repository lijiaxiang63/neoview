import { describe, expect, it } from 'vitest'
import { OpenIntentGate, OpenIntentIssuer } from '../src/shared/openIntents'

describe('open intent ordering', () => {
  it('issues monotonic tokens and rejects an older late arrival', () => {
    const issuer = new OpenIntentIssuer()
    const gate = new OpenIntentGate()
    const older = issuer.issue()
    const newer = issuer.issue()
    expect(gate.accept(newer)).toBe(true)
    expect(gate.accept(older)).toBe(false)
    expect(gate.accept(newer)).toBe(true)
    expect(gate.current()).toBe(newer)
  })
})
