/** Application-wide token source for user intents that may replace the base
 * volume. Tokens are issued before pickers, path probes, or file reads. */
export class OpenIntentIssuer {
  private next = 0

  issue(): number {
    return ++this.next
  }
}

/** Keeps the newest accepted intent. Equal tokens are allowed because one
 * folder operation can publish both streamed and final results. */
export class OpenIntentGate {
  private latest = 0

  accept(token: number): boolean {
    if (!Number.isSafeInteger(token) || token <= 0 || token < this.latest) return false
    if (token > this.latest) this.latest = token
    return true
  }

  current(): number {
    return this.latest
  }
}
