import { type JSX } from 'react'
import { ControlPanel } from './ControlPanel'
import { OverlayPanel } from './OverlayPanel'
import { RegionPanel } from './RegionPanel'
import { RenderPanel } from './RenderPanel'
import { InfoPanel } from './InfoPanel'

export function SidePanel({ onAddOverlay }: { onAddOverlay: () => void }): JSX.Element {
  return (
    <aside className="side-panel">
      <ControlPanel />
      <RegionPanel />
      <OverlayPanel onAdd={onAddOverlay} />
      <RenderPanel />
      <InfoPanel />
    </aside>
  )
}
