import { useEffect, useRef, useState, type JSX } from 'react'
import { useStore } from '../store'
import { RangeSliderDragController } from './RangeSlider'
import {
  keyboardPanelWidth,
  resizedPanelWidth,
  SIDE_PANEL_WIDTH_MAX,
  SIDE_PANEL_WIDTH_MIN
} from '../panelLayout'

/** Drag handle on the side panel's left edge. Pointer lifecycle comes from
 * RangeSliderDragController; only the width math is new (panelLayout.ts).
 * Every width write re-lays-out the workspace grid (canvas resizes in four
 * views), so pointer moves are rAF-coalesced like the other drag gestures. */
export function PanelResizer(): JSX.Element {
  const width = useStore((s) => s.sidePanelWidth)
  const setSidePanelWidth = useStore((s) => s.setSidePanelWidth)
  const resetSidePanelWidth = useStore((s) => s.resetSidePanelWidth)
  const [drag] = useState(() => new RangeSliderDragController())
  const [dragging, setDragging] = useState(false)
  const dragPointerId = useRef<number | null>(null)
  const raf = useRef<number | null>(null)
  const pendingX = useRef(0)

  useEffect(
    () => () => {
      drag.dispose()
      if (raf.current !== null) cancelAnimationFrame(raf.current)
    },
    [drag]
  )

  const onPointerDown = (e: React.PointerEvent): void => {
    e.preventDefault()
    // A frame left over from the previous drag would apply the new pointer
    // position against the old drag's baseline.
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current)
      raf.current = null
    }
    const startX = e.clientX
    const startWidth = useStore.getState().sidePanelWidth
    const started = drag.start(e.currentTarget, e.pointerId, (clientX) => {
      pendingX.current = clientX
      if (raf.current !== null) return
      raf.current = requestAnimationFrame(() => {
        raf.current = null
        setSidePanelWidth(resizedPanelWidth(startWidth, startX, pendingX.current))
      })
    })
    if (started) {
      dragPointerId.current = e.pointerId
      setDragging(true)
    }
  }

  // Only the captured pointer may clear the visual state; a second pointer
  // lifting over the handle (its start was refused) must not.
  const endDrag = (e: React.PointerEvent): void => {
    if (dragPointerId.current !== e.pointerId) return
    dragPointerId.current = null
    setDragging(false)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      resetSidePanelWidth()
      return
    }
    const next = keyboardPanelWidth(useStore.getState().sidePanelWidth, e.key)
    if (next === null) return
    e.preventDefault()
    setSidePanelWidth(next)
  }

  return (
    <div
      className={`panel-resizer${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuemin={SIDE_PANEL_WIDTH_MIN}
      aria-valuemax={SIDE_PANEL_WIDTH_MAX}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize the panel; double-click to reset"
      onPointerDown={onPointerDown}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={resetSidePanelWidth}
      onKeyDown={onKeyDown}
    />
  )
}
