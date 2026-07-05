import { type JSX } from 'react'
import { ControlPanel } from './ControlPanel'
import { RenderPanel } from './RenderPanel'
import { InfoPanel } from './InfoPanel'

export function SidePanel(): JSX.Element {
  return (
    <aside className="side-panel">
      <ControlPanel />
      <RenderPanel />
      <InfoPanel />
    </aside>
  )
}
