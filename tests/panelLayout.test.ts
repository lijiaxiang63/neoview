import { describe, expect, it } from 'vitest'
import {
  clampPanelWidth,
  keyboardPanelWidth,
  PANEL_RESIZE_STEP,
  resizedPanelWidth,
  SIDE_PANEL_WIDTH_DEFAULT,
  SIDE_PANEL_WIDTH_MAX,
  SIDE_PANEL_WIDTH_MIN
} from '../src/renderer/src/panelLayout'

describe('clampPanelWidth', () => {
  it('keeps in-range widths and rounds to whole pixels', () => {
    expect(clampPanelWidth(300)).toBe(300)
    expect(clampPanelWidth(300.4)).toBe(300)
    expect(clampPanelWidth(300.6)).toBe(301)
  })

  it('clamps to the min/max bounds', () => {
    expect(clampPanelWidth(0)).toBe(SIDE_PANEL_WIDTH_MIN)
    expect(clampPanelWidth(SIDE_PANEL_WIDTH_MIN - 1)).toBe(SIDE_PANEL_WIDTH_MIN)
    expect(clampPanelWidth(SIDE_PANEL_WIDTH_MAX + 1)).toBe(SIDE_PANEL_WIDTH_MAX)
    expect(clampPanelWidth(10_000)).toBe(SIDE_PANEL_WIDTH_MAX)
  })

  it('falls back to the default for non-finite input', () => {
    expect(clampPanelWidth(NaN)).toBe(SIDE_PANEL_WIDTH_DEFAULT)
    expect(clampPanelWidth(Infinity)).toBe(SIDE_PANEL_WIDTH_DEFAULT)
    expect(clampPanelWidth(-Infinity)).toBe(SIDE_PANEL_WIDTH_DEFAULT)
  })
})

describe('resizedPanelWidth', () => {
  it('grows when the pointer moves left and shrinks when it moves right', () => {
    expect(resizedPanelWidth(300, 500, 460)).toBe(340)
    expect(resizedPanelWidth(300, 500, 540)).toBe(260)
    expect(resizedPanelWidth(300, 500, 500)).toBe(300)
  })

  it('clamps at both ends of the travel', () => {
    expect(resizedPanelWidth(300, 500, 100)).toBe(SIDE_PANEL_WIDTH_MAX)
    expect(resizedPanelWidth(300, 500, 900)).toBe(SIDE_PANEL_WIDTH_MIN)
  })
})

describe('keyboardPanelWidth', () => {
  it('mirrors the drag directions: ArrowLeft grows, ArrowRight shrinks', () => {
    expect(keyboardPanelWidth(300, 'ArrowLeft')).toBe(300 + PANEL_RESIZE_STEP)
    expect(keyboardPanelWidth(300, 'ArrowRight')).toBe(300 - PANEL_RESIZE_STEP)
  })

  it('clamps steps at the bounds', () => {
    expect(keyboardPanelWidth(SIDE_PANEL_WIDTH_MAX, 'ArrowLeft')).toBe(SIDE_PANEL_WIDTH_MAX)
    expect(keyboardPanelWidth(SIDE_PANEL_WIDTH_MIN, 'ArrowRight')).toBe(SIDE_PANEL_WIDTH_MIN)
  })

  it('jumps to the ARIA min/max with Home/End and ignores other keys', () => {
    expect(keyboardPanelWidth(300, 'Home')).toBe(SIDE_PANEL_WIDTH_MIN)
    expect(keyboardPanelWidth(300, 'End')).toBe(SIDE_PANEL_WIDTH_MAX)
    expect(keyboardPanelWidth(300, 'ArrowUp')).toBeNull()
    expect(keyboardPanelWidth(300, 'a')).toBeNull()
  })
})
