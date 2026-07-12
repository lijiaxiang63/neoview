import { useEffect, useRef, type JSX, type ReactNode } from 'react'
import { useStore, type SidePanelTab } from '../store'
import { autoPanelTab } from '../runtime/appEvents'
import { Tabs, type TabDef } from './Tabs'
import { tabButtonId, tabPanelId } from './tabIds'
import { PanelResizer } from './PanelResizer'
import { ControlPanel } from './ControlPanel'
import { OverlayPanel } from './OverlayPanel'
import { RegionPanel } from './RegionPanel'
import { RenderPanel } from './RenderPanel'
import { InfoPanel } from './InfoPanel'
import type { RegionExportController } from '../runtime/regionExportController'
import type { RendererRuntime } from '../runtime/rendererRuntime'

function TabPanel({
  id,
  active,
  fill,
  children
}: {
  id: SidePanelTab
  active: SidePanelTab
  /** Let flexible content (open label lists) divide the panel's height. */
  fill?: boolean
  children: ReactNode
}): JSX.Element {
  // Inactive panels stay mounted but hidden: frame playback intervals and
  // per-layer collapse/filter state are component-local and must survive
  // tab switches (same approach as the maximized slice views).
  return (
    <div
      className={fill ? 'panel-body panel-body-fill' : 'panel-body'}
      role="tabpanel"
      id={tabPanelId('side', id)}
      aria-labelledby={tabButtonId('side', id)}
      hidden={active !== id}
    >
      {children}
    </div>
  )
}

export function SidePanel({
  onAddOverlay,
  onChooseOverlayTable,
  onUseBuiltInOverlayTable,
  onSelectOverlayTableSource,
  regionExports
}: {
  onAddOverlay: () => void
  onChooseOverlayTable: (id: number) => void
  onUseBuiltInOverlayTable: (id: number) => void
  onSelectOverlayTableSource: RendererRuntime['selectOverlayTableSource']
  regionExports: RegionExportController
}): JSX.Element {
  const tab = useStore((s) => s.sidePanelTab)
  const setSidePanelTab = useStore((s) => s.setSidePanelTab)
  const regionCount = useStore((s) => s.regions.length)
  const layerCount = useStore((s) => s.overlays.length)
  const segBox = useStore((s) => s.segBox)

  // A box appearing (drawn or restored by re-edit) summons the segmentation
  // controls; the previous box rides a ref so only that transition switches.
  const prevBoxRef = useRef(segBox)
  useEffect(() => {
    const next = autoPanelTab(prevBoxRef.current, segBox, useStore.getState().sidePanelTab)
    prevBoxRef.current = segBox
    if (next !== null) setSidePanelTab(next)
  }, [segBox, setSidePanelTab])

  const tabs: TabDef[] = [
    { id: 'display', label: 'Display', title: 'Display range, colormap, and 3D rendering' },
    { id: 'regions', label: 'Regions', badge: regionCount, title: 'Segment and manage regions' },
    { id: 'layers', label: 'Layers', badge: layerCount, title: 'Overlay layers' },
    { id: 'info', label: 'Info', title: 'Volume metadata' }
  ]

  return (
    <aside className="side-panel">
      <PanelResizer />
      <Tabs
        tabs={tabs}
        active={tab}
        onSelect={(id) => setSidePanelTab(id as SidePanelTab)}
        idPrefix="side"
      />
      <TabPanel id="display" active={tab}>
        <ControlPanel />
        <RenderPanel />
      </TabPanel>
      <TabPanel id="regions" active={tab}>
        <RegionPanel exports={regionExports} />
      </TabPanel>
      <TabPanel id="layers" active={tab} fill>
        <OverlayPanel
          onAdd={onAddOverlay}
          onChooseTable={onChooseOverlayTable}
          onUseBuiltInTable={onUseBuiltInOverlayTable}
          onSelectTableSource={onSelectOverlayTableSource}
        />
      </TabPanel>
      <TabPanel id="info" active={tab}>
        <InfoPanel />
      </TabPanel>
    </aside>
  )
}
