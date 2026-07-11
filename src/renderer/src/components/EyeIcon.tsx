import { type JSX } from 'react'

/** Visibility toggle glyph shared by region and layer rows. */
export function EyeIcon({ off }: { off: boolean }): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
        <path d="M1.8 8C3.6 4.9 12.4 4.9 14.2 8C12.4 11.1 3.6 11.1 1.8 8Z" />
        <circle cx="8" cy="8" r="1.9" />
        {off && <line x1="3" y1="13.2" x2="13" y2="2.8" />}
      </g>
    </svg>
  )
}
