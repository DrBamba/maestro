import { useEffect, useMemo, useRef, useState } from 'react'
import Modal from './Modal'

export interface Command {
  id: string
  icon: string
  label: string
  hint?: string
  run: () => void
}

interface CommandPaletteProps {
  commands: Command[]
  onClose: () => void
}

function score(label: string, query: string): number {
  if (!query) return 0
  const l = label.toLowerCase()
  const q = query.toLowerCase()
  const index = l.indexOf(q)
  if (index === 0) return 3
  if (index > 0) return 2
  // Subsequence match, so "nws" still finds "New session".
  let cursor = 0
  for (const ch of q) {
    cursor = l.indexOf(ch, cursor)
    if (cursor === -1) return -1
    cursor++
  }
  return 1
}

export default function CommandPalette({
  commands,
  onClose
}: CommandPaletteProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const matches = useMemo(() => {
    if (!query) return commands
    return commands
      .map((command) => ({ command, s: score(command.label, query) }))
      .filter((entry) => entry.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((entry) => entry.command)
  }, [commands, query])

  useEffect(() => {
    setCursor(0)
  }, [query])

  useEffect(() => {
    listRef.current?.querySelector('.is-cursor')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, matches.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      matches[cursor]?.run()
    }
  }

  return (
    <Modal onClose={onClose} width={560} align="top" padded={false} label="Command palette">
      <div className="palette">
        <div className="palette__search">
          <i className="ph ph-magnifying-glass" />
          <input
            ref={inputRef}
            className="palette__input"
            placeholder="Type a command or session…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="palette__list" ref={listRef}>
          {matches.length === 0 && <div className="palette__empty">No matching commands.</div>}
          {matches.map((command, index) => (
            <button
              key={command.id}
              className={`palette__item${index === cursor ? ' is-cursor' : ''}`}
              onMouseEnter={() => setCursor(index)}
              onClick={command.run}
            >
              <i className={command.icon} />
              <span className="palette__label">{command.label}</span>
              {command.hint && <span className="palette__hint">{command.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}
