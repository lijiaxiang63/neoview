import { useRef, useState, type JSX } from 'react'

interface Props {
  value: number
  /** Called with the parsed value on Enter or blur (already clamped). */
  onCommit: (v: number) => void
  min?: number
  max?: number
  /** Display formatting while not editing (default: fmt-like trim). */
  format?: (v: number) => string
  'aria-label'?: string
  className?: string
}

function defaultFormat(v: number): string {
  return Number(v.toFixed(4)).toString()
}

/**
 * Small numeric input that mirrors an external value: shows the formatted
 * value while idle, free-form text while focused, and commits on Enter/blur
 * (Escape reverts). Values clamp to [min, max]; unparsable input reverts.
 */
export function NumberField({
  value,
  onCommit,
  min,
  max,
  format = defaultFormat,
  className,
  ...aria
}: Props): JSX.Element {
  // null = idle (render the formatted prop); a string = the user is editing.
  const [text, setText] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const commit = (): void => {
    if (text !== null) {
      const v = Number(text.trim())
      if (text.trim() !== '' && Number.isFinite(v)) {
        let out = v
        if (min !== undefined) out = Math.max(min, out)
        if (max !== undefined) out = Math.min(max, out)
        if (out !== value) onCommit(out)
      }
    }
    setText(null)
  }

  return (
    <input
      ref={inputRef}
      className={`num-field mono${className ? ` ${className}` : ''}`}
      type="text"
      inputMode="decimal"
      value={text ?? format(value)}
      onFocus={(e) => {
        setText(String(value))
        // Select-all so typing replaces instead of appending.
        requestAnimationFrame(() => e.target.select())
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
          inputRef.current?.blur()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          setText(null)
          inputRef.current?.blur()
        }
      }}
      {...aria}
    />
  )
}
