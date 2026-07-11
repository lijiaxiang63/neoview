/**
 * Pure geometry for the resizable side panel: width clamps, pointer-drag
 * math, and the keyboard resize map. The React resizer only wires events.
 */

export const SIDE_PANEL_WIDTH_DEFAULT = 280
export const SIDE_PANEL_WIDTH_MIN = 240
export const SIDE_PANEL_WIDTH_MAX = 480

/** Keyboard resize granularity in pixels. */
export const PANEL_RESIZE_STEP = 16

export function clampPanelWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDE_PANEL_WIDTH_DEFAULT
  return Math.min(SIDE_PANEL_WIDTH_MAX, Math.max(SIDE_PANEL_WIDTH_MIN, Math.round(px)))
}

/** The panel is the rightmost column and its handle sits on its left edge,
 * so dragging left (decreasing clientX) grows the panel. */
export function resizedPanelWidth(
  startWidth: number,
  startClientX: number,
  clientX: number
): number {
  return clampPanelWidth(startWidth + (startClientX - clientX))
}

/** Arrow keys follow the drag directions (left grows); Home/End follow the
 * ARIA separator convention (min/max of aria-valuenow, i.e. the width).
 * null = not handled. */
export function keyboardPanelWidth(width: number, key: string): number | null {
  switch (key) {
    case 'ArrowLeft':
      return clampPanelWidth(width + PANEL_RESIZE_STEP)
    case 'ArrowRight':
      return clampPanelWidth(width - PANEL_RESIZE_STEP)
    case 'Home':
      return SIDE_PANEL_WIDTH_MIN
    case 'End':
      return SIDE_PANEL_WIDTH_MAX
    default:
      return null
  }
}
