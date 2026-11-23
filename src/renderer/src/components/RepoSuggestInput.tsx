import { forwardRef, useEffect, useMemo, useState } from 'react'

interface RepoSuggestInputProps {
  id: string
  value: string
  onChange: (value: string) => void
  /** Enter with no suggestion highlighted. */
  onEnter: () => void
  /** Undefined while loading, null when gh could not list them. */
  repos: string[] | null | undefined
  placeholder?: string
}

/**
 * A text field that suggests the account's repos as you type: any `owner/name` containing the
 * text, case-insensitively, and all of them while it is empty. Free text still goes through, so a
 * clone URL or a repo outside the list works as before.
 */
const RepoSuggestInput = forwardRef<HTMLInputElement, RepoSuggestInputProps>(function RepoSuggestInput(
  { id, value, onChange, onEnter, repos, placeholder },
  ref
) {
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(-1)

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase()
    return (repos ?? []).filter((r) => r.toLowerCase().includes(q))
  }, [repos, value])

  useEffect(() => setCursor(-1), [value, repos])

  const pick = (repo: string): void => {
    onChange(repo)
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      const step = e.key === 'ArrowDown' ? 1 : -1
      setCursor((c) => Math.max(-1, Math.min(matches.length - 1, c + step)))
    } else if (e.key === 'Enter') {
      if (open && cursor >= 0 && matches[cursor]) pick(matches[cursor])
      else onEnter()
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation()
      setOpen(false)
    }
  }

  useEffect(() => {
    if (cursor >= 0) document.getElementById(`${id}-opt-${cursor}`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor, id])

  const show = open && repos !== null && (repos === undefined || matches.length > 0 || value.trim() !== '')

  return (
    <div className="suggest">
      <input
        id={id}
        ref={ref}
        className="input"
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={show}
        aria-controls={`${id}-list`}
        aria-activedescendant={cursor >= 0 ? `${id}-opt-${cursor}` : undefined}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {show && (
        <div className="suggest__list" id={`${id}-list`} role="listbox">
          {repos === undefined ? (
            <div className="suggest__empty">
              <span className="spinner" /> Loading repos…
            </div>
          ) : matches.length === 0 ? (
            <div className="suggest__empty">No matching repos</div>
          ) : (
            matches.map((r, i) => (
              <div
                key={r}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === cursor}
                className={`suggest__item${i === cursor ? ' is-cursor' : ''}`}
                // Before the input's blur, which would close the list first.
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(r)
                }}
                onMouseEnter={() => setCursor(i)}
              >
                {r}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
})

export default RepoSuggestInput
