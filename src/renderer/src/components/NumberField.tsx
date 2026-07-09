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
  // Event-time copy of `text`. blur() inside the Enter/Escape handlers fires
  // onBlur synchronously, before React applies their setText — a commit
  // closing over `text` would see the pre-keystroke value (committing what
  // Escape just reverted). The ref is what commit reads; clearing it also
  // makes commit one-shot, so Enter's commit-then-blur can't fire twice.
  const editText = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const setEditText = (t: string | null): void => {
    editText.current = t
    setText(t)
  }

  const commit = (): void => {
    const t = editText.current
    setEditText(null)
    if (t === null) return
    const v = Number(t.trim())
    if (t.trim() !== '' && Number.isFinite(v)) {
      let out = v
      if (min !== undefined) out = Math.max(min, out)
      if (max !== undefined) out = Math.min(max, out)
      if (out !== value) onCommit(out)
    }
  }

  return (
    <input
      ref={inputRef}
      className={`num-field mono${className ? ` ${className}` : ''}`}
      type="text"
      inputMode="decimal"
      value={text ?? format(value)}
      onFocus={(e) => {
        setEditText(String(value))
        // Select-all so typing replaces instead of appending.
        requestAnimationFrame(() => e.target.select())
      }}
      onChange={(e) => setEditText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          // blur is the one committer; it reads the up-to-date ref.
          e.preventDefault()
          inputRef.current?.blur()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          setEditText(null)
          inputRef.current?.blur()
        }
      }}
      {...aria}
    />
  )
}
