import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  computeFrames,
  groupOf,
  groupsOf,
  inside,
  insertTab,
  nudgeSizes,
  setSizes,
  splitGroup,
  zoneAt,
  zoneRect,
  type Axis,
  type DropZone,
  type Frame,
  type Gutter,
  type LayoutNode,
  type Rect
} from '../lib/layout'

/**
 * One tab and the pane behind it. The pane is a node rather than a render function because every
 * pane is mounted for the life of the session — a terminal that unmounts loses its process, and the
 * editor embed would reload — so panes are laid out by rectangle and never move in the DOM.
 */
export interface BoardTab {
  key: string
  label: React.ReactNode
  icon?: string
  tip?: string
  /** The label is a field being typed into: no drag, and a press lands in the text. */
  editing?: boolean
  onActivate?: () => void
  onDoubleClick?: () => void
  onClose?: () => void
  pane: React.ReactNode
}

interface TabBoardProps {
  tabs: BoardTab[]
  layout: LayoutNode
  onLayout: (next: LayoutNode) => void
  /** The group whose pane holds the keyboard. Frames say so, and new tabs open there. */
  focusedGroupId: string | null
  /**
   * Raised with the tab the user just touched, which is how focus follows a click or a drop. The
   * flag marks a drop, where the tab may already have been the focused one.
   */
  onFocus: (key: string, moved?: boolean) => void
  onAddTab: (groupId: string) => void
  /** Names the + in every strip, for its label and its tip alike. */
  addLabel: string
}

/** Tab strip height, in pixels — panes are positioned under it, so it is a number and not only CSS. */
const STRIP_H = 34
/** The channel between two panes: the grab area for resizing them. */
const GAP = 12
/** No pane shrinks past this, whichever axis is being dragged. */
const MIN_PANE = 160
/** Pointer travel before a press on a tab becomes a drag rather than a click. */
const DRAG_SLOP = 6

interface Drop {
  groupId: string
  zone: DropZone
  /** The tab it lands in front of, when dropping into a strip. Null appends. */
  before: string | null
  /** Board-relative x of the insertion caret, when dropping into a strip. */
  caret: number
}

interface Drag {
  key: string
  x: number
  y: number
  drop: Drop | null
}

function box(rect: Rect): React.CSSProperties {
  return {
    left: Math.round(rect.x),
    top: Math.round(rect.y),
    width: Math.max(0, Math.round(rect.w)),
    height: Math.max(0, Math.round(rect.h))
  }
}

/** The frame's inside, below its strip and within its border — where a pane is drawn. */
function paneRect(rect: Rect): Rect {
  return {
    x: rect.x + 1,
    y: rect.y + STRIP_H + 1,
    w: Math.max(0, rect.w - 2),
    h: Math.max(0, rect.h - STRIP_H - 2)
  }
}

export default function TabBoard({
  tabs,
  layout,
  onLayout,
  focusedGroupId,
  onFocus,
  onAddTab,
  addLabel
}: TabBoardProps): React.JSX.Element {
  const boardRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [drag, setDrag] = useState<Drag | null>(null)
  /** The axis being resized, which is only ever needed to say what the cursor should be. */
  const [resizing, setResizing] = useState<Axis | null>(null)

  /*
   * Measured before the paint that first needs it, rather than after it.
   *
   * Panes are positioned from this measurement, and a session mounts — or comes back from
   * display:none — already at its full size. Waiting for the observer, which reports after the
   * paint, would show a frame of zero-sized panes, and a terminal cannot take focus while it has no
   * box. Only when there is no measurement to use: reading a box costs a synchronous layout, and
   * the observer has every later change covered.
   */
  useLayoutEffect(() => {
    if (size.w > 0 && size.h > 0) return
    const host = boardRef.current
    if (!host) return
    const next = { w: host.clientWidth, h: host.clientHeight }
    if (next.w > 0 && next.h > 0) setSize(next)
  })

  useLayoutEffect(() => {
    const host = boardRef.current
    if (!host) return
    const observer = new ResizeObserver(() => {
      setSize((current) => {
        const next = { w: host.clientWidth, h: host.clientHeight }
        return current.w === next.w && current.h === next.h ? current : next
      })
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const { frames, gutters } = computeFrames(layout, { x: 0, y: 0, w: size.w, h: size.h }, GAP)
  const groups = groupsOf(layout)

  // Read inside pointer handlers, which outlive the render that started them.
  const layoutRef = useRef(layout)
  const framesRef = useRef<Frame[]>(frames)
  layoutRef.current = layout
  framesRef.current = frames

  const byKey = new Map(tabs.map((tab) => [tab.key, tab]))

  /** Where in a strip a drop would land, read off the tabs actually on screen. */
  const stripInsertion = useCallback(
    (frame: Frame, clientX: number, moving: string, boardLeft: number) => {
      const strip = boardRef.current?.querySelector(`[data-strip="${frame.id}"]`)
      let caret = frame.rect.x + 8
      if (!strip) return { before: null as string | null, caret }
      for (const element of strip.querySelectorAll<HTMLElement>('[data-tab-key]')) {
        const key = element.dataset.tabKey
        if (!key || key === moving) continue
        const rect = element.getBoundingClientRect()
        if (clientX < rect.left + rect.width / 2) {
          return { before: key, caret: rect.left - boardLeft }
        }
        caret = rect.right - boardLeft
      }
      return { before: null as string | null, caret }
    },
    []
  )

  const dropAt = useCallback(
    (clientX: number, clientY: number, moving: string): Drop | null => {
      const board = boardRef.current?.getBoundingClientRect()
      if (!board) return null
      const x = clientX - board.left
      const y = clientY - board.top
      const frame = framesRef.current.find((candidate) => inside(candidate.rect, x, y))
      if (!frame) return null
      const zone = zoneAt(frame.rect, x, y, STRIP_H)
      if (zone !== 'tabs') return { groupId: frame.id, zone, before: null, caret: 0 }
      const { before, caret } = stripInsertion(frame, clientX, moving, board.left)
      return { groupId: frame.id, zone, before, caret }
    },
    [stripInsertion]
  )

  const applyDrop = useCallback(
    (key: string, drop: Drop | null) => {
      if (!drop) return
      const current = layoutRef.current
      const source = groupOf(current, key)
      /*
       * Raised for every drop, before the layout changes and even when the drop asks for nothing.
       * A tab that moves between strips is a new element, so the press that carried it there leaves
       * focus on nothing — this is what hands the keyboard to the pane it landed in.
       */
      onFocus(key, true)
      if (drop.zone === 'center') {
        // Already this pane's own tab: dropping it back on itself changes nothing.
        if (source?.id === drop.groupId) return
        onLayout(insertTab(current, key, drop.groupId))
      } else if (drop.zone === 'tabs') {
        onLayout(insertTab(current, key, drop.groupId, drop.before))
      } else {
        onLayout(splitGroup(current, drop.groupId, key, drop.zone))
      }
    },
    [onFocus, onLayout]
  )

  /*
   * A press that turned into a drag still ends in a click on the tab it started from, because the
   * capture retargets the release there — and that click would activate the tab, undoing the move
   * with a layout read from before the drop. So the drop marks the press, and the click that
   * follows is spent on the mark rather than on the tab.
   */
  const dragged = useRef(false)

  const beginTabDrag = useCallback(
    (event: React.PointerEvent, tab: BoardTab) => {
      if (event.button !== 0 || tab.editing) return
      dragged.current = false
      const element = event.currentTarget as HTMLElement
      const pointerId = event.pointerId
      const origin = { x: event.clientX, y: event.clientY }
      const held = { live: false, drop: null as Drop | null }

      const move = (moved: PointerEvent): void => {
        if (!held.live) {
          const travelled =
            Math.abs(moved.clientX - origin.x) + Math.abs(moved.clientY - origin.y)
          if (travelled < DRAG_SLOP) return
          held.live = true
          /*
           * Capture, and a shield over the whole board once the drag is live: an embed is a program
           * of its own and swallows the pointer the moment it crosses one, which would otherwise
           * end the drag somewhere over the editor.
           */
          try {
            element.setPointerCapture(pointerId)
          } catch {
            // The pointer is already gone; the window listeners still see the rest of the drag.
          }
        }
        const board = boardRef.current?.getBoundingClientRect()
        held.drop = dropAt(moved.clientX, moved.clientY, tab.key)
        setDrag({
          key: tab.key,
          x: moved.clientX - (board?.left ?? 0),
          y: moved.clientY - (board?.top ?? 0),
          drop: held.drop
        })
      }

      const end = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', end)
        window.removeEventListener('pointercancel', end)
        if (held.live) {
          dragged.current = true
          applyDrop(tab.key, held.drop)
        }
        setDrag(null)
      }

      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', end)
      window.addEventListener('pointercancel', end)
    },
    [applyDrop, dropAt]
  )

  const beginResize = useCallback(
    (event: React.PointerEvent, gutter: Gutter) => {
      if (event.button !== 0) return
      const element = event.currentTarget as HTMLElement
      const pointerId = event.pointerId
      const row = gutter.axis === 'row'
      const from = row ? event.clientX : event.clientY
      const along = gutter.along || 1
      const minimum = MIN_PANE / along
      const sizes = gutter.sizes
      try {
        element.setPointerCapture(pointerId)
      } catch {
        // Nothing to capture; the window listeners carry the drag.
      }
      setResizing(gutter.axis)

      // Measured from where the drag started rather than accumulated, so the gutter tracks the
      // pointer exactly even after it has been held against a minimum.
      const move = (moved: PointerEvent): void => {
        const delta = ((row ? moved.clientX : moved.clientY) - from) / along
        onLayout(
          setSizes(
            layoutRef.current,
            gutter.splitId,
            nudgeSizes(sizes, gutter.index, delta, minimum)
          )
        )
      }
      const end = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', end)
        window.removeEventListener('pointercancel', end)
        setResizing(null)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', end)
      window.addEventListener('pointercancel', end)
    },
    [onLayout]
  )

  const nudgeGutter = useCallback(
    (event: React.KeyboardEvent, gutter: Gutter) => {
      const row = gutter.axis === 'row'
      const back = row ? 'ArrowLeft' : 'ArrowUp'
      const forward = row ? 'ArrowRight' : 'ArrowDown'
      if (event.key !== back && event.key !== forward) return
      event.preventDefault()
      const along = gutter.along || 1
      const step = (24 / along) * (event.key === forward ? 1 : -1)
      onLayout(
        setSizes(
          layoutRef.current,
          gutter.splitId,
          nudgeSizes(gutter.sizes, gutter.index, step, MIN_PANE / along)
        )
      )
    },
    [onLayout]
  )

  const lifted = drag ? byKey.get(drag.key) : undefined
  const dropFrame = drag?.drop ? frames.find((frame) => frame.id === drag.drop!.groupId) : undefined

  return (
    <div
      className="board"
      ref={boardRef}
      style={{ '--strip-h': `${STRIP_H}px` } as React.CSSProperties}
    >
      {frames.map((frame) => {
        const group = groups.find((candidate) => candidate.id === frame.id)
        if (!group) return null
        return (
          <section
            key={frame.id}
            className={`board__frame${frame.id === focusedGroupId ? ' is-focused' : ''}`}
            style={box(frame.rect)}
          >
            <nav className="tabs board__strip" data-strip={frame.id}>
              {group.tabs.map((key) => {
                const tab = byKey.get(key)
                if (!tab) return null
                const on = group.active === key
                const body = (
                  <>
                    {tab.icon && <i className={tab.icon} style={{ fontSize: 15 }} />}
                    {tab.label}
                    {tab.onClose && (
                      <i
                        className="ph ph-x tab__close"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          tab.onClose?.()
                        }}
                      />
                    )}
                  </>
                )
                // A field cannot live inside a button, so a tab being renamed is a plain span —
                // which is also exactly when it must not be draggable.
                return tab.editing ? (
                  <span key={key} className={`tab${on ? ' is-on' : ''}`} data-tab-key={key}>
                    {body}
                  </span>
                ) : (
                  <button
                    key={key}
                    type="button"
                    className={`tab${on ? ' is-on' : ''}${drag?.key === key ? ' is-lifted' : ''}`}
                    data-tab-key={key}
                    data-tip={tab.tip}
                    onPointerDown={(e) => beginTabDrag(e, tab)}
                    onClick={() => {
                      if (dragged.current) return
                      tab.onActivate?.()
                    }}
                    onDoubleClick={tab.onDoubleClick}
                  >
                    {body}
                  </button>
                )
              })}
              <button
                type="button"
                className="tab tab--add"
                aria-label={addLabel}
                data-tip={addLabel}
                onClick={() => onAddTab(group.id)}
              >
                <i className="ph ph-plus" style={{ fontSize: 13 }} />
              </button>
            </nav>
            <div className="board__well" />
          </section>
        )
      })}

      {/*
       * Every pane is a sibling here, positioned over its frame, and stays in this list for the life
       * of the session. Rearranging moves a rectangle, never a DOM node — which is what keeps a
       * terminal's process and the editor's workbench alive across a drag.
       */}
      {tabs.map((tab) => {
        const group = groupOf(layout, tab.key)
        const frame = group ? frames.find((candidate) => candidate.id === group.id) : undefined
        const shown = Boolean(group && frame && group.active === tab.key)
        return (
          <div
            key={tab.key}
            className="board__pane"
            // Which tab a pane belongs to. Every terminal's focus target looks alike from outside,
            // so this is what makes "the keyboard is in Claude, not in a console" answerable.
            data-pane-key={tab.key}
            style={{
              ...box(frame ? paneRect(frame.rect) : { x: 0, y: 0, w: 0, h: 0 }),
              display: shown ? 'flex' : 'none'
            }}
            onPointerDownCapture={() => {
              if (group) onFocus(group.active)
            }}
          >
            {tab.pane}
          </div>
        )
      })}

      {gutters.map((gutter) => (
        <div
          key={`${gutter.splitId}:${gutter.index}`}
          className={`board__gutter board__gutter--${gutter.axis}`}
          role="separator"
          aria-orientation={gutter.axis === 'row' ? 'vertical' : 'horizontal'}
          aria-label="Resize panes"
          tabIndex={0}
          style={box(gutter.rect)}
          onPointerDown={(e) => beginResize(e, gutter)}
          onKeyDown={(e) => nudgeGutter(e, gutter)}
        />
      ))}

      {(drag || resizing) && (
        <div
          className={`board__shield board__shield--${
            drag ? 'drag' : resizing === 'row' ? 'col' : 'row'
          }`}
        />
      )}

      {dropFrame && drag?.drop && (
        <>
          <div className="board__drop" style={box(zoneRect(dropFrame.rect, drag.drop.zone))} />
          {drag.drop.zone === 'tabs' && (
            <div
              className="board__caret"
              style={{
                left: Math.round(drag.drop.caret),
                top: Math.round(dropFrame.rect.y + 5),
                height: STRIP_H - 10
              }}
            />
          )}
        </>
      )}

      {drag && lifted && (
        <div
          className="board__ghost"
          // Flipped to the other side of the pointer near the right edge, where it would otherwise
          // be dragged off the window and out of sight exactly as the drop is being aimed.
          style={{
            left: drag.x + (drag.x > size.w - 180 ? -14 : 14),
            top: Math.min(drag.y + 12, Math.max(0, size.h - 34)),
            transform: drag.x > size.w - 180 ? 'translateX(-100%)' : undefined
          }}
        >
          {lifted.icon && <i className={lifted.icon} />}
          {lifted.label}
        </div>
      )}
    </div>
  )
}
