/** Narrow, immutable conversion for the measured CN identity rules. */
export const CHANNEL_COMPAT_RULE_VERSION = 'cn-dsh-compat-v3'

const ORIGINAL = 'You are an AI agent powered by DeepSeek Harness.'
const NEUTRAL = 'You are an AI agent.'
const OPENER = /^([\s\uFEFF]*)You are an AI agent powered by DeepSeek Harness\.(?=$|\s)/u
const GUI_ORIGINAL = 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.'
const GUI_NEUTRAL = 'You are interacting with the user through the current Web GUI whose URL the runtime context names.'
const GUI_GUARD = 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.'

export interface ChannelCompatOptions {
  region: 'cn' | 'global'
  enabled: boolean
}

export interface ChannelCompatResult {
  body: unknown
  matchedMessages: number
  unsupportedLayouts: number
  ruleVersion: typeof CHANNEL_COMPAT_RULE_VERSION
}

/**
 * Strings whose presence in an outbound body is the fingerprint this rule set
 * exists to remove. Counted, never rewritten, and reported by name so a future
 * capture compares like with like instead of re-deriving the list.
 *
 * The list is deliberately the *observable* surface (what the wire carries
 * verbatim), not a claim about which of them the upstream reads: 10-22 showed
 * the same product name being accepted on one day and refused the next, so the
 * only reliable use of these markers is trend detection over captured bodies.
 */
export const CHANNEL_COMPAT_MARKERS = [
  'DeepSeek Harness',
  'Web GUI',
  'Agent Teams',
  'dsh-mneme',
  'You are an AI agent',
] as const

/** Which rule, if either, changed one message's text. */
export interface ChannelCompatTextDigest {
  /** R1: the opener sentence naming the product. */
  opener: 'changed' | 'unchanged' | 'unsupported'
  /** R2: the Web-GUI sentence, wherever it starts a line. */
  gui: 'changed' | 'unchanged' | 'unsupported'
  charsBefore: number
  charsAfter: number
  paragraphs: number
  /** Occurrences of the exact R2 source sentence *before* the rewrite. */
  guiOriginalCount: number
  /** Occurrences of the neutral replacement *after* it. */
  neutralCount: number
  /** First characters of the last non-empty paragraph, before the rewrite. */
  lastParagraphHead: string
  changed: boolean
}

/**
 * Per-body digest of what the identity rules did, for diagnostics only.
 *
 * Reported alongside a request instead of the request itself: the numbers that
 * distinguish "the patch did not run" from "the upstream refused a compliant
 * body" are the outcome kinds, the character delta, and whether the source
 * sentence survived. None of them carries message content beyond an 80-character
 * paragraph head.
 */
export interface ChannelCompatDigest {
  ruleVersion: typeof CHANNEL_COMPAT_RULE_VERSION
  region: 'cn' | 'global'
  enabled: boolean
  /** system/developer messages seen in the body. */
  systemMessages: number
  matchedMessages: number
  unsupportedLayouts: number
  /** Digest of the last system/developer message: the one DSH itself sends. */
  lastSystem?: ChannelCompatTextDigest
  /** Marker occurrences across the whole body, before and after the rewrite. */
  markers?: { before: Record<string, number>; after: Record<string, number> }
}

type TextRewrite = { kind: 'changed'; text: string } | { kind: 'unchanged' | 'unsupported' }
type ContentRewrite = { kind: 'changed'; content: unknown } | { kind: 'unchanged' | 'unsupported' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function rewriteText(text: string, hasFollowingBlock: boolean): TextRewrite {
  const match = OPENER.exec(text)
  if (match !== null) {
    // A block boundary alone does not prove a sentence boundary in the next block.
    if (hasFollowingBlock && match[0].length === text.length) return { kind: 'unsupported' }
    return { kind: 'changed', text: (match[1] ?? '') + NEUTRAL + text.slice(match[0].length) }
  }
  if (hasFollowingBlock && ORIGINAL.startsWith(text.trimStart())) return { kind: 'unsupported' }
  return { kind: 'unchanged' }
}

function rewriteOpenerContent(content: unknown): ContentRewrite {
  if (typeof content === 'string') {
    const result = rewriteText(content, false)
    return result.kind === 'changed' ? { kind: 'changed', content: result.text } : result
  }
  if (!Array.isArray(content)) return { kind: 'unchanged' }
  for (const [index, block] of content.entries()) {
    if (!isRecord(block) || block['type'] !== 'text' || typeof block['text'] !== 'string') {
      return { kind: 'unsupported' }
    }
    if (block['text'].trim().length === 0) continue
    const result = rewriteText(block['text'], index < content.length - 1)
    if (result.kind !== 'changed') return result
    const next = content.slice()
    next[index] = { ...block, text: result.text }
    return { kind: 'changed', content: next }
  }
  return { kind: 'unchanged' }
}

/**
 * R2 replaces the sentence wherever it begins a line, not only when it begins the
 * last paragraph.
 *
 * v2 required "last non-empty paragraph" and produced a silent no-op in production:
 * a capture on 2026-10-22 showed a 41-paragraph system prompt whose final paragraph
 * was another plugin's attribution line, so the trigger sentence survived verbatim
 * (`gui: unchanged`, `guiOriginalCount: 1`, `neutralCount: 0`) while the digest still
 * reported the switch as enabled. The upstream refused every attempt with
 * `channel_rejected`.
 *
 * The tightened conditions that remain are the ones that carry meaning: the sentence
 * must be unique, must start a line (never mid-sentence prose, never an indented or
 * quoted form), must not sit inside a code fence, and must be followed by the guard
 * sentence on one line. Position within the document is not evidence of anything.
 */
function rewriteGuiText(text: string): TextRewrite {
  const start = text.indexOf(GUI_ORIGINAL)
  if (start < 0) return { kind: 'unchanged' }
  if (text.indexOf(GUI_ORIGINAL, start + GUI_ORIGINAL.length) >= 0) return { kind: 'unsupported' }
  if (/\r(?!\n)/u.test(text)) return { kind: 'unchanged' }

  let offset = 0
  let lineStart = -1
  let fence: { character: string; width: number } | undefined
  let candidateInFence = false
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const visible = offset === 0 && line.startsWith('\uFEFF') ? line.slice(1) : line
    if (start >= offset && start < offset + raw.length) {
      candidateInFence = fence !== undefined
      lineStart = offset
    }
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(visible)
    if (marker !== null) {
      const run = marker[1]!
      if (fence === undefined) fence = { character: run[0]!, width: run.length }
      else if (run[0] === fence.character && run.length >= fence.width && visible.slice(marker[0].length).trim().length === 0) fence = undefined
    }
    offset += raw.length + 1
  }
  if (candidateInFence || lineStart < 0) return { kind: 'unchanged' }
  let prefix = text.slice(lineStart, start)
  if (lineStart === 0 && prefix.startsWith('\uFEFF')) prefix = prefix.slice(1)
  if (!/^ {0,3}$/u.test(prefix)) return { kind: 'unchanged' }

  const after = text.slice(start + GUI_ORIGINAL.length)
  const gap = /^\s+/u.exec(after)?.[0]
  if (gap === undefined || /\n[ \t]*\r?\n/u.test(gap) || !after.startsWith(GUI_GUARD, gap.length)) return { kind: 'unchanged' }
  const guardEnd = gap.length + GUI_GUARD.length
  if (guardEnd < after.length && !/\s/u.test(after[guardEnd]!)) return { kind: 'unchanged' }
  return { kind: 'changed', text: text.slice(0, start) + GUI_NEUTRAL + text.slice(start + GUI_ORIGINAL.length) }
}

function rewriteGuiContent(content: unknown): ContentRewrite {
  if (typeof content === 'string') {
    const result = rewriteGuiText(content)
    return result.kind === 'changed' ? { kind: 'changed', content: result.text } : result
  }
  if (!Array.isArray(content)) return { kind: 'unchanged' }
  const only = content[0]
  if (content.length === 1 && isRecord(only) && only['type'] === 'text' && typeof only['text'] === 'string') {
    const result = rewriteGuiText(only['text'])
    return result.kind === 'changed' ? { kind: 'changed', content: [{ ...only, text: result.text }] } : result
  }
  // Only classify visible candidates in a leading text run. Do not traverse barriers.
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'text' || typeof block['text'] !== 'string') break
    if (block['text'].includes(GUI_ORIGINAL)) return { kind: 'unsupported' }
  }
  return { kind: 'unchanged' }
}

/** Preserve caller-owned data; copy only matched paths and never join text blocks. */
export function rewriteChannelIdentity(body: unknown, options: ChannelCompatOptions): ChannelCompatResult {
  const result: ChannelCompatResult = {
    body, matchedMessages: 0, unsupportedLayouts: 0, ruleVersion: CHANNEL_COMPAT_RULE_VERSION,
  }
  if (options.region !== 'cn' || options.enabled !== true || !isRecord(body)) return result
  const messages = body['messages']
  if (!Array.isArray(messages)) return result
  let nextMessages: unknown[] | undefined
  for (const [index, message] of messages.entries()) {
    if (!isRecord(message) || (message['role'] !== 'system' && message['role'] !== 'developer')) continue
    const opener = rewriteOpenerContent(message['content'])
    const gui = rewriteGuiContent(opener.kind === 'changed' ? opener.content : message['content'])
    if (opener.kind === 'unsupported' || gui.kind === 'unsupported') result.unsupportedLayouts++
    const rewritten = gui.kind === 'changed' ? gui : opener
    if (rewritten.kind !== 'changed') continue
    nextMessages ??= messages.slice()
    nextMessages[index] = { ...message, content: rewritten.content }
    result.matchedMessages++
  }
  if (nextMessages !== undefined) result.body = { ...body, messages: nextMessages }
  return result
}

/** Count non-overlapping occurrences without regex escaping concerns. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** First characters of the last non-empty paragraph, for location evidence. */
function lastParagraphHead(text: string, limit = 80): string {
  const paragraphs = text.split(/\n[ \t]*\r?\n/u).map(part => part.trim()).filter(part => part.length > 0)
  const last = paragraphs[paragraphs.length - 1] ?? ''
  return last.slice(0, limit)
}

/**
 * Digest one message text through the same two primitives
 * {@link rewriteChannelIdentity} uses, so the report and the rewrite can never
 * disagree about what the rules did.
 */
function digestText(text: string, active: boolean): ChannelCompatTextDigest {
  // A disabled rewrite leaves the body byte-identical, so the digest must say
  // so even though the primitives themselves would still rewrite this text.
  // Reporting `changed: true` on a body nobody touched is exactly the kind of
  // diagnostic lie this module exists to prevent.
  const opener = active ? rewriteOpenerContent(text) : { kind: 'unchanged' as const }
  const source = opener.kind === 'changed' ? opener.content : text
  const gui = active ? rewriteGuiContent(source) : { kind: 'unchanged' as const }
  const after = gui.kind === 'changed' ? gui.content
    : opener.kind === 'changed' ? opener.content
      : text
  const afterText = typeof after === 'string' ? after : text
  return {
    opener: opener.kind,
    gui: gui.kind,
    charsBefore: text.length,
    charsAfter: afterText.length,
    paragraphs: text.split(/\n[ \t]*\r?\n/u).filter(part => part.trim().length > 0).length,
    guiOriginalCount: countOccurrences(text, GUI_ORIGINAL),
    neutralCount: countOccurrences(afterText, GUI_NEUTRAL),
    lastParagraphHead: lastParagraphHead(text),
    changed: afterText !== text,
  }
}

/**
 * Report what {@link rewriteChannelIdentity} would do to one body, without
 * exposing message content.
 *
 * The rewrite itself is delegated to {@link rewriteChannelIdentity}, so an
 * enabled digest taken before the call and an enabled digest taken after it
 * describe the same decision. Markers are counted on the whole serialized body
 * and require a JSON round-trip, which is why callers gate this behind the
 * capture switch rather than running it on every request.
 */
export function digestChannelCompat(body: unknown, options: ChannelCompatOptions): ChannelCompatDigest {
  const applied = rewriteChannelIdentity(body, options)
  const digest: ChannelCompatDigest = {
    ruleVersion: CHANNEL_COMPAT_RULE_VERSION,
    region: options.region,
    enabled: options.enabled === true,
    systemMessages: 0,
    matchedMessages: applied.matchedMessages,
    unsupportedLayouts: applied.unsupportedLayouts,
  }
  const active = options.region === 'cn' && options.enabled === true
  if (!isRecord(body)) return digest
  const messages = body['messages']
  if (!Array.isArray(messages)) return digest
  for (const message of messages) {
    if (!isRecord(message) || (message['role'] !== 'system' && message['role'] !== 'developer')) continue
    digest.systemMessages++
    const content = message['content']
    // Only a plain string carries a directly comparable character delta; the
    // block-array shape is left to the whole-body marker counts.
    if (typeof content === 'string') digest.lastSystem = digestText(content, active)
  }
  const countMarkers = (value: unknown): Record<string, number> => {
    const serialised = JSON.stringify(value) ?? ''
    const counts: Record<string, number> = {}
    for (const marker of CHANNEL_COMPAT_MARKERS) counts[marker] = countOccurrences(serialised, marker)
    return counts
  }
  digest.markers = { before: countMarkers(body), after: countMarkers(applied.body) }
  return digest
}
