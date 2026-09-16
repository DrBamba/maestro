/**
 * Short random names for a session's worktree directory and its initial branch.
 *
 * The directory used to be a slug of what the user typed, which stopped working once that text
 * became Claude's opening message: a sentence makes a 48-character path, and the path is the one
 * thing that can never be corrected afterwards — Claude Code keys its conversation history by the
 * absolute working directory, so renaming the directory orphans the transcript.
 *
 * A fixed-length handle sidesteps that entirely, and it means creating a session waits on nothing:
 * the name is generated locally, and the readable name arrives later from Claude's own title.
 *
 * Two words rather than an opaque id because the basename is what shows up in the VS Code title
 * bar, the shell prompt inside the worktree, and `git worktree list` — "brisk-otter" stays
 * tellable apart there in a way that "k3f9q2" does not.
 */

const ADJECTIVES = [
  'amber', 'ashen', 'balmy', 'brave', 'brief', 'brisk', 'calm', 'civil',
  'clean', 'clear', 'cosy', 'crisp', 'daily', 'deft', 'dry', 'eager',
  'early', 'fair', 'fast', 'fine', 'firm', 'fleet', 'fond', 'frank',
  'fresh', 'glad', 'grand', 'green', 'hardy', 'ivory', 'jolly', 'keen',
  'kind', 'level', 'light', 'lively', 'lucid', 'lucky', 'mild', 'neat',
  'noble', 'olive', 'plain', 'prime', 'proud', 'quick', 'quiet', 'rapid',
  'ready', 'rosy', 'royal', 'ruddy', 'sage', 'sandy', 'sharp', 'sleek',
  'slim', 'snug', 'solid', 'sound', 'spry', 'stark', 'steady', 'stout',
  'sunny', 'swift', 'tidy', 'trim', 'true', 'vivid', 'warm', 'wise'
]

const NOUNS = [
  'alder', 'anvil', 'arbor', 'badger', 'basin', 'beacon', 'birch', 'bison',
  'bramble', 'brook', 'cedar', 'cinder', 'cliff', 'clover', 'comet', 'cove',
  'crane', 'creek', 'crow', 'dune', 'eagle', 'ember', 'falcon', 'fern',
  'finch', 'fjord', 'forge', 'glade', 'grove', 'harbor', 'hawk', 'heath',
  'heron', 'kestrel', 'lark', 'ledge', 'lynx', 'maple', 'marsh', 'meadow',
  'mesa', 'moss', 'otter', 'owl', 'pebble', 'pine', 'quarry', 'raven',
  'reef', 'ridge', 'river', 'rowan', 'sable', 'shale', 'shore', 'slate',
  'sparrow', 'spruce', 'stone', 'summit', 'thicket', 'thistle', 'tide',
  'trail', 'vale', 'willow', 'wren'
]

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)]
}

/** e.g. "brisk-otter". Always filesystem- and git-safe, and always short. */
export function randomHandle(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`
}
