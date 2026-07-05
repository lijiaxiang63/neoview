import type { LoadResponse, TexPayload } from './worker'
import type { Volume } from './types'

// The 3D texture payload rides alongside the volume without polluting the
// Volume type: keyed weakly so it is freed together with its volume. The
// lookup is deliberately non-consuming — StrictMode double-runs effects, and
// a one-shot take would force an expensive main-thread rebuild on the rerun.
const initialTex = new WeakMap<Volume, TexPayload>()

/** Worker-built texture payload for a freshly loaded volume, if available. */
export function initialTexOf(vol: Volume): TexPayload | null {
  return initialTex.get(vol) ?? null
}

/**
 * Load a volume off the main thread. A fresh worker per call keeps the
 * message protocol trivially race-free; startup cost is negligible next to
 * the decode work, and terminate() releases the worker's memory promptly.
 */
export function loadVolume(
  name: string,
  bytes: ArrayBuffer,
  opts?: { skipTex?: boolean }
): Promise<Volume> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    const finish = (fn: () => void): void => {
      worker.terminate()
      fn()
    }
    worker.onmessage = (e: MessageEvent<LoadResponse>) => {
      const msg = e.data
      finish(() => {
        if (msg.ok) {
          if (msg.tex) initialTex.set(msg.volume, msg.tex)
          resolve(msg.volume)
        } else {
          reject(new Error(msg.message))
        }
      })
    }
    worker.onerror = () => {
      finish(() => reject(new Error('Could not open file.')))
    }
    worker.postMessage({ name, bytes, skipTex: opts?.skipTex }, [bytes])
  })
}
