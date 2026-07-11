/** One id contract for the tab button / tabpanel ARIA pairing, shared by
 * Tabs (buttons) and the caller that renders the matching panels. */
export function tabButtonId(idPrefix: string, id: string): string {
  return `${idPrefix}-tab-${id}`
}

export function tabPanelId(idPrefix: string, id: string): string {
  return `${idPrefix}-panel-${id}`
}
