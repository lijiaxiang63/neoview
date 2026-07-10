import { StrictMode, useLayoutEffect, useMemo, type JSX } from 'react'
import App from '../App'
import { useStore } from '../store'
import { composeVoxelMap } from '../volume/affine'
import { loadVolume } from '../volume/loadVolume'
import { createRendererRuntime } from './rendererRuntime'

/** Application composition root. It stays outside StrictMode so the runtime
 * and its coordinator have one owner while the view tree is stress-mounted. */
export default function RuntimeRoot(): JSX.Element {
  // Fast Refresh deliberately recomputes memo values even with stable deps.
  // That gives the refreshed effect a new runtime instead of reviving an
  // instance whose cleanup permanently invalidated its pending async work.
  const runtime = useMemo(
    () =>
      createRendererRuntime({
        store: useStore,
        bridge: window.neoview,
        windowTarget: window,
        documentTarget: document,
        loadVolume,
        volumesAlign: (base, overlay) => composeVoxelMap(base.affine, overlay.affine) !== null,
        confirm: (message) => window.confirm(message)
      }),
    []
  )

  useLayoutEffect(() => {
    runtime.init()
    return () => runtime.dispose()
  }, [runtime])

  return (
    <StrictMode>
      <App runtime={runtime} />
    </StrictMode>
  )
}
