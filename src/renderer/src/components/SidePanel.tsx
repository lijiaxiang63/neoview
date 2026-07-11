import { type JSX } from 'react'
import { ControlPanel } from './ControlPanel'
import { OverlayPanel } from './OverlayPanel'
import { RegionPanel } from './RegionPanel'
import { RenderPanel } from './RenderPanel'
import { InfoPanel } from './InfoPanel'
import type { RegionExportController } from '../runtime/regionExportController'

export function SidePanel({
  onAddOverlay,
  regionExports
}: {
  onAddOverlay: () => void
  regionExports: RegionExportController
}): JSX.Element {
  return (
    <aside className="side-panel">
      <ControlPanel />
      <RegionPanel exports={regionExports} />
      <OverlayPanel onAdd={onAddOverlay} />
      <RenderPanel />
      <InfoPanel />
    </aside>
  )
}
