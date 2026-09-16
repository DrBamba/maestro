import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Conversation } from '@shared/types'
import { claudeHistoryDirs } from './sessions'

/**
 * Reads Claude Code's own conversation store so the user can pick which conversation a session
 * resumes, rather than relying on `--continue` and hoping it lands on the right one.
 *
 * `--continue` also silently declines a conversation that another Claude still holds open, which
 * is what produces "No conversation found to continue" for a worktree whose terminal session is
 * still running. Resuming by explicit id — forking when it is still live — avoids that entirely.
 */

/** A conversation written to within this window is assumed to still be open elsewhere. */
const LIVE_WINDOW_MS = 3 * 60 * 1000

/** Guard against parsing something pathological; real transcripts are a few MB. */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024

interface TranscriptEntry {
  type?: string
  customTitle?: string
  aiTitle?: string
  lastPrompt?: string
  timestamp?: string
  message?: { content?: unknown }
}

/**
 * A parsed transcript, plus the one thing the renderer has no use for: whether the title was
 * actually written by Claude or merely fell back to the opening prompt. Naming a session needs
 * that distinction — the opening prompt is the text we are trying to replace.
 */
interface Parsed extends Conversation {
  /** Claude's own title for the conversation, or the user's if they renamed it. '' when neither. */
  named: string
}

/**
 * The opening line the user typed, used to name a conversation Claude never titled. Turns whose
 * content is a wrapper — system reminders, command output, caveats — are skipped: they are
 * machinery, not something the user would recognise.
 */
function openingPrompt(entry: TranscriptEntry): string {
  const content = entry.message?.content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    const part = content.find(
      (p): p is { type: string; text: string } =>
        typeof p === 'object' && p !== null && (p as { type?: string }).type === 'text'
    )
    text = part?.text ?? ''
  }
  text = text.trim()
  if (!text || text.startsWith('<')) return ''
  return text.split('\n').find((line) => line.trim())?.trim().slice(0, 90) ?? ''
}

async function parseTranscript(file: string, id: string, now: number): Promise<Parsed | null> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(file)
  } catch {
    return null
  }
  if (!info.isFile() || info.size === 0 || info.size > MAX_TRANSCRIPT_BYTES) return null

  let customTitle = ''
  let aiTitle = ''
  let firstPrompt = ''
  let lastPrompt = ''
  let messages = 0
  let lastEntryAt = 0

  try {
    const text = await readFile(file, 'utf8')
    for (const line of text.split('\n')) {
      if (!line) continue
      let entry: TranscriptEntry
      try {
        entry = JSON.parse(line) as typeof entry
      } catch {
        continue
      }
      if (entry.timestamp) {
        const at = Date.parse(entry.timestamp)
        if (Number.isFinite(at) && at > lastEntryAt) lastEntryAt = at
      }
      // Titles and prompts are appended over the life of a session; the last one wins.
      if (entry.type === 'custom-title' && entry.customTitle) customTitle = entry.customTitle
      else if (entry.type === 'ai-title' && entry.aiTitle) aiTitle = entry.aiTitle
      else if (entry.type === 'last-prompt' && entry.lastPrompt) lastPrompt = entry.lastPrompt
      else if (entry.type === 'user' || entry.type === 'assistant') {
        messages++
        if (entry.type === 'user' && !firstPrompt) firstPrompt = openingPrompt(entry)
      }
    }
  } catch {
    return null
  }

  if (messages === 0) return null

  /*
   * Recency comes from the timestamps inside the transcript, not the file's mtime.
   *
   * Copying a history directory — which relocating a worktree does — restamps every file with the
   * copy time, and not in recency order. Sorting by mtime therefore reordered the conversations
   * and "continue most recent" handed back the wrong one. The in-file timestamps are the
   * conversation's own record and survive being copied.
   */
  const updatedAt = lastEntryAt || info.mtimeMs

  /*
   * Claude writes an `ai-title` entry of its own a few lines into every conversation; `custom-title`
   * is the user overriding it by hand, so it wins. Either beats the opening line, which is only a
   * fallback for a conversation too young to have been titled at all.
   */
  const named = customTitle || aiTitle

  return {
    id,
    named,
    title: named || firstPrompt,
    lastPrompt: lastPrompt.slice(0, 160),
    updatedAt,
    messages,
    live: now - updatedAt < LIVE_WINDOW_MS
  }
}

async function parseAll(worktreePath: string): Promise<Parsed[]> {
  const now = Date.now()
  const found = new Map<string, Parsed>()

  for (const dir of claudeHistoryDirs(worktreePath)) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const id = name.slice(0, -'.jsonl'.length)
      if (found.has(id)) continue
      const parsed = await parseTranscript(join(dir, name), id, now)
      if (parsed) found.set(id, parsed)
    }
  }

  return [...found.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Conversations Claude Code has for a directory, most recently active first. */
export async function listConversations(worktreePath: string): Promise<Conversation[]> {
  return parseAll(worktreePath)
}

/**
 * The newest conversation in this worktree, with the title Claude has given it — empty while it
 * has not written one yet. This is what names a session: the agent already summarises its own
 * conversation a few seconds in, so Maestro reads that instead of asking a model itself.
 *
 * Null means nothing has been said here at all, which is a different thing from an untitled
 * conversation and the reason this returns the conversation rather than the title alone. A session
 * whose first message is typed into Claude rather than passed at launch sits in that state for as
 * long as the user takes to write it, and a title is not late until there is something to title.
 * `parseAll` already drops a transcript with no exchange in it, so an empty list is that state.
 */
export async function newestConversation(worktreePath: string): Promise<{ title: string } | null> {
  const [newest] = await parseAll(worktreePath)
  return newest ? { title: newest.named } : null
}
