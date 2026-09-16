/**
 * Where a session's panes are.
 *
 * A tree of splits with a tab group at every leaf. One group is the default — every tab in one
 * strip, one pane on screen — and dragging a tab to the edge of a group splits it, which is what
 * makes halves, quarters and any mix of the two the same structure rather than three special cases.
 *
 * A split holds fractions of its parent, never pixels, so an arrangement survives a resized window
 * and a reopened session. Every function here is pure and returns a fresh tree.
 */

export type Axis = 'row' | 'column'

export interface TabGroup {
  kind: 'group'
  id: string
  /** Tab keys, in strip order. */
  tabs: string[]
  /** The one showing. Empty only for a group about to be pruned. */
  active: string
}

export interface Split {
  kind: 'split'
  id: string
  axis: Axis
  /** One fraction per child, summing to 1. */
  sizes: number[]
  children: LayoutNode[]
}

export type LayoutNode = TabGroup | Split

/** Where a dragged tab would land: into a group's strip, over its pane, or against one of its edges. */
export type DropZone = 'tabs' | 'center' | 'left' | 'right' | 'top' | 'bottom'

let seq = 0

function freshId(prefix: string): string {
  seq += 1
  return `${prefix}${seq}`
}

export function makeGroup(tabs: string[], active?: string): TabGroup {
  return {
    kind: 'group',
    id: freshId('g'),
    tabs: [...tabs],
    active: active && tabs.includes(active) ? active : (tabs[0] ?? '')
  }
}

export function groupsOf(node: LayoutNode): TabGroup[] {
  return node.kind === 'group' ? [node] : node.children.flatMap(groupsOf)
}

/** True once the session has been arranged into more than one pane. */
export function isArranged(node: LayoutNode): boolean {
  return node.kind === 'split'
}

export function groupOf(node: LayoutNode, key: string): TabGroup | null {
  return groupsOf(node).find((group) => group.tabs.includes(key)) ?? null
}

/** The group each tab sits in, for asking whether a pane is the focused one. */
export function tabGroupIds(node: LayoutNode): Map<string, string> {
  const at = new Map<string, string>()
  for (const group of groupsOf(node)) for (const key of group.tabs) at.set(key, group.id)
  return at
}

/** The tabs on screen — one per group. */
export function activeTabs(node: LayoutNode): Set<string> {
  return new Set(groupsOf(node).map((group) => group.active).filter(Boolean))
}

/** Every tab in the tree, in the order the strips read left to right, top to bottom. */
export function allTabs(node: LayoutNode): string[] {
  return groupsOf(node).flatMap((group) => group.tabs)
}

function mapGroups(node: LayoutNode, f: (group: TabGroup) => TabGroup): LayoutNode {
  if (node.kind === 'group') return f(node)
  return { ...node, children: node.children.map((child) => mapGroups(child, f)) }
}

/** Drops a tab, landing the group on the tab next to the one that went rather than on the first. */
function withoutTab(group: TabGroup, key: string): TabGroup {
  if (!group.tabs.includes(key)) return group
  const at = group.tabs.indexOf(key)
  const tabs = group.tabs.filter((tab) => tab !== key)
  const active = group.active === key ? (tabs[at] ?? tabs[at - 1] ?? '') : group.active
  return { ...group, tabs, active }
}

function shares(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (total <= 0) return sizes.map(() => 1 / sizes.length)
  return sizes.map((size) => size / total)
}

/**
 * Removes empty groups, unwraps splits left holding one child, and flattens a split nested inside
 * another on the same axis — so three panes in a row stay one split of three, whatever order they
 * were dragged into, and the gutter between any two of them resizes only those two.
 *
 * Null means nothing is left, which the callers turn back into a group.
 */
function normalize(node: LayoutNode): LayoutNode | null {
  if (node.kind === 'group') return node.tabs.length === 0 ? null : node

  const children: LayoutNode[] = []
  const sizes: number[] = []
  node.children.forEach((child, index) => {
    const kept = normalize(child)
    if (!kept) return
    if (kept.kind === 'split' && kept.axis === node.axis) {
      kept.children.forEach((inner, at) => {
        children.push(inner)
        sizes.push(node.sizes[index] * kept.sizes[at])
      })
    } else {
      children.push(kept)
      sizes.push(node.sizes[index])
    }
  })

  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  return { ...node, children, sizes: shares(sizes) }
}

function settle(node: LayoutNode): LayoutNode {
  return normalize(node) ?? makeGroup([])
}

/** Shows a tab that is already in the tree. */
export function activateTab(node: LayoutNode, key: string): LayoutNode {
  return mapGroups(node, (group) => (group.tabs.includes(key) ? { ...group, active: key } : group))
}

/**
 * Puts a tab in a group and shows it there — opening a new one, or moving an existing one, which
 * differ only in whether it had to be taken out of somewhere first.
 *
 * `before` is the tab it lands in front of; null appends.
 */
export function insertTab(
  node: LayoutNode,
  key: string,
  groupId: string,
  before: string | null = null
): LayoutNode {
  if (!groupsOf(node).some((group) => group.id === groupId)) return node
  return settle(
    mapGroups(node, (group) => {
      if (group.id !== groupId) return withoutTab(group, key)
      const tabs = group.tabs.filter((tab) => tab !== key)
      const at = before === null ? -1 : tabs.indexOf(before)
      if (at === -1) tabs.push(key)
      else tabs.splice(at, 0, key)
      return { ...group, tabs, active: key }
    })
  )
}

export function removeTab(node: LayoutNode, key: string): LayoutNode {
  return settle(mapGroups(node, (group) => withoutTab(group, key)))
}

/**
 * Splits a group in two, the moved tab taking the named edge. The group it came from is pruned if
 * that emptied it, so dragging the last tab out of a pane closes the pane rather than leaving a
 * blank one behind.
 */
export function splitGroup(
  node: LayoutNode,
  groupId: string,
  key: string,
  zone: 'left' | 'right' | 'top' | 'bottom'
): LayoutNode {
  const source = groupOf(node, key)
  // Nothing to split off: the tab is already the whole of that pane.
  if (source && source.id === groupId && source.tabs.length === 1) return node

  const landing = makeGroup([key], key)
  const axis: Axis = zone === 'left' || zone === 'right' ? 'row' : 'column'
  const first = zone === 'left' || zone === 'top'

  let placed = false
  const place = (current: LayoutNode): LayoutNode => {
    if (current.kind === 'group') {
      if (current.id !== groupId) return current
      placed = true
      return {
        kind: 'split',
        id: freshId('s'),
        axis,
        sizes: [0.5, 0.5],
        children: first ? [landing, current] : [current, landing]
      }
    }
    return { ...current, children: current.children.map(place) }
  }

  const split = place(node)
  if (!placed) return node
  return settle(mapGroups(split, (group) => (group.id === landing.id ? group : withoutTab(group, key))))
}

export function setSizes(node: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  if (node.kind === 'group') return node
  if (node.id === splitId && sizes.length === node.children.length) {
    return { ...node, sizes: shares(sizes) }
  }
  return { ...node, children: node.children.map((child) => setSizes(child, splitId, sizes)) }
}

/**
 * Moves one gutter by a fraction of its split, taking the room from the pane on the other side and
 * stopping before either becomes unusably narrow.
 */
export function nudgeSizes(
  sizes: number[],
  index: number,
  delta: number,
  minimum: number
): number[] {
  // How far the gutter may travel each way before one side hits the floor. Clamped against zero as
  // well, so a pane already narrower than the minimum is never pushed further in.
  const back = Math.min(0, minimum - sizes[index])
  const forward = Math.max(0, sizes[index + 1] - minimum)
  const step = Math.max(back, Math.min(delta, forward))
  const next = [...sizes]
  next[index] += step
  next[index + 1] -= step
  return next
}

// ── geometry ────────────────────────────────────────────────────────────────

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Frame {
  id: string
  rect: Rect
}

export interface Gutter {
  splitId: string
  /** Sits after child `index`. */
  index: number
  axis: Axis
  rect: Rect
  /** The pixels this split's children share, so a drag in pixels becomes a fraction. */
  along: number
  sizes: number[]
}

export interface Frames {
  frames: Frame[]
  gutters: Gutter[]
}

/** Turns the tree into the rectangles it draws as, gutters included. */
export function computeFrames(node: LayoutNode, board: Rect, gap: number): Frames {
  const frames: Frame[] = []
  const gutters: Gutter[] = []

  const walk = (current: LayoutNode, rect: Rect): void => {
    if (current.kind === 'group') {
      frames.push({ id: current.id, rect })
      return
    }
    const row = current.axis === 'row'
    const count = current.children.length
    const along = Math.max(0, (row ? rect.w : rect.h) - gap * (count - 1))
    let cursor = row ? rect.x : rect.y

    current.children.forEach((child, index) => {
      const size = along * current.sizes[index]
      walk(
        child,
        row
          ? { x: cursor, y: rect.y, w: size, h: rect.h }
          : { x: rect.x, y: cursor, w: rect.w, h: size }
      )
      cursor += size
      if (index < count - 1) {
        gutters.push({
          splitId: current.id,
          index,
          axis: current.axis,
          along,
          sizes: current.sizes,
          rect: row
            ? { x: cursor, y: rect.y, w: gap, h: rect.h }
            : { x: rect.x, y: cursor, w: rect.w, h: gap }
        })
        cursor += gap
      }
    })
  }

  walk(node, board)
  return { frames, gutters }
}

export function inside(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h
}

/**
 * The pane next to another one in a given direction, or null when there is nothing that way.
 *
 * Read off the geometry rather than off the tree, because the tree does not answer this question: in
 * a column nested inside a row, the pane to the right of the top-left one is a cousin rather than a
 * sibling. Measured on a unit board, so it needs no window.
 *
 * Where several panes lie that way, the nearest edge wins, and a tie between two stacked against the
 * same edge goes to the one whose middle is closest — so moving right out of a tall pane lands
 * beside where the eye already was rather than at the top of the next column.
 */
export function paneToward(
  node: LayoutNode,
  fromId: string,
  toward: 'left' | 'right' | 'up' | 'down'
): string | null {
  const { frames } = computeFrames(node, { x: 0, y: 0, w: 1, h: 1 }, 0)
  const from = frames.find((frame) => frame.id === fromId)
  if (!from) return null

  const horizontal = toward === 'left' || toward === 'right'
  const back = toward === 'left' || toward === 'up'
  // Along the direction of travel; across it for the tie-break.
  const near = (r: Rect): number => (horizontal ? r.x : r.y)
  const far = (r: Rect): number => (horizontal ? r.x + r.w : r.y + r.h)
  const middle = (r: Rect): number => (horizontal ? r.y + r.h / 2 : r.x + r.w / 2)
  const EPSILON = 1e-6

  const candidates = frames.filter((frame) =>
    back ? far(frame.rect) <= near(from.rect) + EPSILON : near(frame.rect) >= far(from.rect) - EPSILON
  )
  if (candidates.length === 0) return null

  const distance = (r: Rect): number =>
    back ? near(from.rect) - far(r) : near(r) - far(from.rect)

  const best = candidates.reduce((winner, frame) => {
    const gap = distance(frame.rect) - distance(winner.rect)
    if (Math.abs(gap) > EPSILON) return gap < 0 ? frame : winner
    const off = Math.abs(middle(frame.rect) - middle(from.rect))
    return off < Math.abs(middle(winner.rect) - middle(from.rect)) ? frame : winner
  })
  return best.id
}

/**
 * Which zone of a frame a point is in. The nearest edge wins inside the outer fifth, so a corner
 * resolves to the edge it is actually closest to rather than to whichever was tested first.
 */
export function zoneAt(rect: Rect, x: number, y: number, stripHeight: number): DropZone {
  if (y - rect.y <= stripHeight) return 'tabs'
  const fx = rect.w > 0 ? (x - rect.x) / rect.w : 0.5
  const fy = rect.h > 0 ? (y - rect.y) / rect.h : 0.5
  const edges: [DropZone, number][] = [
    ['left', fx],
    ['right', 1 - fx],
    ['top', fy],
    ['bottom', 1 - fy]
  ]
  const [zone, distance] = edges.reduce((best, edge) => (edge[1] < best[1] ? edge : best))
  return distance < 0.22 ? zone : 'center'
}

/** The half of a frame a drop would take, for the preview the drag paints. */
export function zoneRect(rect: Rect, zone: DropZone): Rect {
  const half = { ...rect }
  if (zone === 'left' || zone === 'right') half.w = rect.w / 2
  if (zone === 'top' || zone === 'bottom') half.h = rect.h / 2
  if (zone === 'right') half.x = rect.x + rect.w / 2
  if (zone === 'bottom') half.y = rect.y + rect.h / 2
  return half
}
