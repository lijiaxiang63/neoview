import { StrictMode, useLayoutEffect, useMemo, type JSX } from 'react'
import App from '../App'
import { useStore } from '../store'
import { composeVoxelMap } from '../volume/affine'
import { loadVolume } from '../volume/loadVolume'
import { createRendererRuntime } from './rendererRuntime'
import { RegionExportController } from './regionExportController'
import { UpdatePresenter } from './updatePresenter'

/** Application composition root. It stays outside StrictMode so the runtime
 * and its coordinator have one owner while the view tree is stress-mounted. */
export default function RuntimeRoot(): JSX.Element {
  // Fast Refresh deliberately recomputes memo values even with stable deps.
  // That gives the refreshed effect a new runtime instead of reviving an
  // instance whose cleanup permanently invalidated its pending async work.
  const services = useMemo(() => {
    const runtime = createRendererRuntime({
      store: useStore,
      bridge: window.neoview,
      windowTarget: window,
      documentTarget: document,
      loadVolume,
      volumesAlign: (base, overlay) => composeVoxelMap(base.affine, overlay.affine) !== null,
      confirm: (message) => window.confirm(message)
    })
    const regionExports = new RegionExportController({
      store: useStore,
      bridge: window.neoview,
      storage: localStorage,
      loadVolume
    })
    const updates = new UpdatePresenter({
      bridge: window.neoview,
      openExternal: (url) => void window.open(url)
    })
    return { runtime, regionExports, updates }
  }, [])
  const { runtime, regionExports, updates } = services

  useLayoutEffect(() => {
    runtime.init()
    updates.init()
    return () => {
      updates.dispose()
      regionExports.dispose()
      runtime.dispose()
    }
  }, [regionExports, runtime, updates])

  return (
    <StrictMode>
      <App
        runtime={runtime}
        regionExports={regionExports}
        updates={updates}
        revealInFolder={window.neoview.revealInFolder}
      />
    </StrictMode>
  )
}
