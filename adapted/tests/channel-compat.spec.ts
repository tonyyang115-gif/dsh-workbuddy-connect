import { describe, expect, it } from 'vitest'
import { digestChannelCompat, rewriteChannelIdentity } from '../src/channel-compat.ts'

const ORIGINAL = 'You are an AI agent powered by DeepSeek Harness.'
const NEUTRAL = 'You are an AI agent.'
const ENABLED = { region: 'cn' as const, enabled: true }
const body = (content: unknown, role = 'system') => ({ messages: [{ role, content }] })

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

describe('cn-dsh-prefix-v1 text contract', () => {
  it('changes only the complete opener and preserves caller-owned objects', () => {
    const input = freeze({
      model: 'm', max_tokens: 512, reasoning_effort: 'high',
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
      messages: [
        { role: 'system', content: ORIGINAL + '\nKeep every instruction.' },
        { role: 'user', content: ORIGINAL },
        { role: 'assistant', tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'actual result' },
      ],
      unknown: { retained: true },
    })
    const result = rewriteChannelIdentity(input, ENABLED)
    expect(result).toMatchObject({ matchedMessages: 1, unsupportedLayouts: 0, ruleVersion: 'cn-dsh-compat-v3' })
    expect(result.body).toEqual({
      ...input, messages: [{ role: 'system', content: NEUTRAL + '\nKeep every instruction.' }, ...input.messages.slice(1)],
    })
    expect(input.messages[0]?.content).toBe(ORIGINAL + '\nKeep every instruction.')
  })

  it.each(['', ' \n\t', '\uFEFF', '\uFEFF \r\n'])('preserves leading whitespace and BOM %j', prefix => {
    expect(rewriteChannelIdentity(body(prefix + ORIGINAL + '\nnext'), ENABLED).body)
      .toEqual(body(prefix + NEUTRAL + '\nnext'))
  })

  it.each([
    'Earlier instruction. ' + ORIGINAL,
    ORIGINAL.toLowerCase(),
    ORIGINAL.slice(0, -1),
    ORIGINAL + 'example',
    'You are an AI agent powered by DeepSeek Harness Pro.',
    '\u200B' + ORIGINAL,
  ])('does not broaden the prefix rule: %j', content => {
    const input = body(content)
    expect(rewriteChannelIdentity(input, ENABLED).body).toBe(input)
  })

  it.each(['user', 'assistant', 'tool'])('does not rewrite the %s role', role => {
    const input = body(ORIGINAL, role)
    expect(rewriteChannelIdentity(input, ENABLED).body).toBe(input)
  })

  it('handles every eligible message, preserving roles and later mentions', () => {
    const input = { messages: [
      { role: 'system', content: ORIGINAL + '\n' + ORIGINAL },
      { role: 'developer', content: ORIGINAL },
      { role: 'system', content: 'No matching opener.' },
    ] }
    const result = rewriteChannelIdentity(input, ENABLED)
    expect(result.matchedMessages).toBe(2)
    expect(result.body).toEqual({ messages: [
      { role: 'system', content: NEUTRAL + '\n' + ORIGINAL },
      { role: 'developer', content: NEUTRAL },
      input.messages[2],
    ] })
    const second = rewriteChannelIdentity(result.body, ENABLED)
    expect(second.body).toBe(result.body)
    expect(second.matchedMessages).toBe(0)
  })
})

const GUI = 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.'
const CURRENT_GUI = 'You are interacting with the user through the current Web GUI whose URL the runtime context names.'
const GUI_GUARD = 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.'
const GUI_PARAGRAPH = GUI + ' ' + GUI_GUARD + ' Starting another server does not update this GUI.'

describe('cn-dsh-web-gui-v1 guarded sentence contract', () => {
  it('changes only the GUI sentence, preserving tools, other messages and shared references', () => {
    const input = freeze({
      model: 'hy3', max_tokens: 512, stream: true,
      tools: Array.from({ length: 63 }, (_, i) => ({ type: 'function', function: { name: `fixture_${i}`, parameters: { type: 'object' } } })),
      messages: [
        { role: 'system', content: NEUTRAL + '\n\n' + GUI_PARAGRAPH, tag: 'keep' },
        { role: 'user', content: GUI_PARAGRAPH },
        { role: 'assistant', tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: GUI_PARAGRAPH },
      ],
      extra: { retained: true },
    })
    const result = rewriteChannelIdentity(input, ENABLED)
    const output = result.body as typeof input
    expect(result).toMatchObject({ matchedMessages: 1, unsupportedLayouts: 0, ruleVersion: 'cn-dsh-compat-v3' })
    expect(output).toEqual({ ...input, messages: [{ ...input.messages[0], content: NEUTRAL + '\n\n' + GUI_PARAGRAPH.replace(GUI, CURRENT_GUI) }, ...input.messages.slice(1)] })
    expect(output.tools).toBe(input.tools)
    expect(output.extra).toBe(input.extra)
    expect(output.messages[1]).toBe(input.messages[1])
    expect(input.messages[0]?.content).toBe(NEUTRAL + '\n\n' + GUI_PARAGRAPH)
    expect(rewriteChannelIdentity(output, ENABLED)).toMatchObject({ body: output, matchedMessages: 0 })
    expect(rewriteChannelIdentity(output, ENABLED).body).toBe(output)
  })

  it('counts two rules in the same message once, and handles independent developer messages', () => {
    const input = { messages: [
      { role: 'system', content: ORIGINAL + '\n\n' + GUI_PARAGRAPH },
      { role: 'developer', content: GUI_PARAGRAPH },
    ] }
    const result = rewriteChannelIdentity(input, ENABLED)
    expect(result.matchedMessages).toBe(2)
    expect(result.body).toEqual({ messages: [
      { role: 'system', content: NEUTRAL + '\n\n' + GUI_PARAGRAPH.replace(GUI, CURRENT_GUI) },
      { role: 'developer', content: GUI_PARAGRAPH.replace(GUI, CURRENT_GUI) },
    ] })
  })

  it('rewrites the sentence when another plugin appends a trailing paragraph', () => {
    // Shape taken from the 2026-10-22 capture: 41 paragraphs, R1 at the top, the
    // GUI paragraph at 22, and billion-context's attribution line last. v2 keyed
    // on "last paragraph" and therefore did nothing here — the sentence went out
    // verbatim and every attempt came back channel_rejected.
    const paragraphs = Array.from({ length: 21 }, (_, index) => `Section ${index + 1} instruction.`)
    const content = [ORIGINAL, ...paragraphs, GUI_PARAGRAPH,
      'Context management for this conversation is provided by billion-context (github.com/ranxianglei/billion-context).']
      .join('\n\n')
    const result = rewriteChannelIdentity(body(content), ENABLED)
    expect(result).toMatchObject({ matchedMessages: 1, unsupportedLayouts: 0 })
    const written = (result.body as { messages: { content: string }[] }).messages[0]!.content
    expect(written).toContain(CURRENT_GUI)
    expect(written).not.toContain(GUI)
    expect(written.endsWith('provided by billion-context (github.com/ranxianglei/billion-context).')).toBe(true)
    expect(written).toContain(NEUTRAL)
    const digest = digestChannelCompat(body(content), ENABLED)
    expect(digest.lastSystem).toMatchObject({ opener: 'changed', gui: 'changed', guiOriginalCount: 1, neutralCount: 1 })
    // R1 saves 28 (`powered by DeepSeek Harness`), R2 saves 9 (`DeepSeek Harness ` -> `current `).
    const saved = (ORIGINAL.length - NEUTRAL.length) + (GUI.length - CURRENT_GUI.length)
    expect(digest.lastSystem!.charsAfter).toBe(digest.lastSystem!.charsBefore - saved)
    expect(digest.lastSystem!.lastParagraphHead).toContain('billion-context')
  })

  it.each([
    GUI_PARAGRAPH,
    '\uFEFF' + GUI_PARAGRAPH,
    '\uFEFF   ' + GUI_PARAGRAPH,
    'Context.\n\n' + GUI_PARAGRAPH,
    'Context.\r\n \t\r\n   ' + GUI_PARAGRAPH + '\r\n \t\r\n',
    'Context.\n\n' + GUI_PARAGRAPH.replace(GUI + ' ', GUI + '\n '),
    'Context.\n\n' + GUI + ' ' + GUI_GUARD,
    'Context.\n\n' + GUI_PARAGRAPH + '\nSingle-line continuation.',
    // v3: content after the sentence is no longer disqualifying — a trailing
    // paragraph from another plugin used to make R2 a silent no-op on the wire.
    GUI_PARAGRAPH + '\n\nLater instruction.',
    'Context.\n\n' + GUI_PARAGRAPH + '\n\nContext management for this conversation is provided by billion-context.',
    '```text\nExample.\n```\n\n' + GUI_PARAGRAPH,
    '~~~text\nExample.\n~~~~\n\n' + GUI_PARAGRAPH,
    '  ```text\nExample.\n   ```\n\n' + GUI_PARAGRAPH,
  ])('preserves supported whitespace and completed preceding examples: %j', content => {
    expect(rewriteChannelIdentity(body(content), ENABLED).body).toEqual(body(content.replace(GUI, CURRENT_GUI)))
  })

  it.each([
    'Example: ' + GUI_PARAGRAPH,
    '> ' + GUI_PARAGRAPH,
    '"' + GUI_PARAGRAPH + '"',
    '    ' + GUI_PARAGRAPH,
    '\t' + GUI_PARAGRAPH,
    '\n\n\uFEFF' + GUI_PARAGRAPH,
    GUI_PARAGRAPH.replace(GUI, GUI.toLowerCase()),
    GUI_PARAGRAPH.replace('whose URL', 'whose\nURL'),
    GUI_PARAGRAPH.replace('whose URL the runtime context names.', 'at http://127.0.0.1:1.'),
    GUI_PARAGRAPH.replace(GUI + ' ', GUI + 'X '),
    GUI,
    GUI + '\n\n' + GUI_GUARD,
    GUI + '\r\n \t\r\n' + GUI_GUARD,
    GUI_PARAGRAPH.replace(GUI_GUARD, GUI_GUARD + 'X'),
    'Context.\r\r' + GUI_PARAGRAPH,
    '```text\n\n' + GUI_PARAGRAPH + '\n```',
    '~~~\n\n' + GUI_PARAGRAPH + '\n~~~',
    '   ```\n\n' + GUI_PARAGRAPH,
    '````\n```\n\n' + GUI_PARAGRAPH,
    '```\n~~~\n\n' + GUI_PARAGRAPH,
    '```\n```not-a-close\n\n' + GUI_PARAGRAPH,
    '```text\u2028example\n\n' + GUI_PARAGRAPH,
  ])('does not broaden matching into quotes, code or changed templates: %j', content => {
    const input = freeze(body(content))
    expect(rewriteChannelIdentity(input, ENABLED).body).toBe(input)
  })

  it('keeps R1 when R2 is ambiguous, and counts the unsupported message once', () => {
    const content = ORIGINAL + '\n\n' + GUI + '\n\n' + GUI_PARAGRAPH
    const result = rewriteChannelIdentity(body(content), ENABLED)
    expect(result).toMatchObject({ matchedMessages: 1, unsupportedLayouts: 1 })
    expect(result.body).toEqual(body(content.replace(ORIGINAL, NEUTRAL)))
  })

  it('preserves a sole text block and all metadata', () => {
    const input = freeze(body([{ type: 'text', text: GUI_PARAGRAPH, tag: { retained: true } }]))
    expect(rewriteChannelIdentity(input, ENABLED).body)
      .toEqual(body([{ type: 'text', text: GUI_PARAGRAPH.replace(GUI, CURRENT_GUI), tag: { retained: true } }]))
  })

  it.each([
    [{ type: 'text', text: 'Context.' }, { type: 'text', text: GUI_PARAGRAPH }],
    [{ type: 'text', text: GUI.slice(0, 40) }, { type: 'text', text: GUI.slice(40) + ' ' + GUI_GUARD }],
    [{ type: 'image_url', image_url: { url: 'fixture' } }, { type: 'text', text: GUI_PARAGRAPH }],
    [{ type: 'unknown', text: GUI_PARAGRAPH }],
  ].map(content => ({ content })))('does not combine or traverse unsupported block layouts: $content', ({ content }) => {
    const input = freeze(body(content))
    expect(rewriteChannelIdentity(input, ENABLED).body).toBe(input)
  })

  it('keeps the original R1 array capability when R2 requires multiple blocks', () => {
    const content = [{ type: 'text', text: ORIGINAL + '\nKeep.' }, { type: 'text', text: GUI_PARAGRAPH }]
    const result = rewriteChannelIdentity(body(content), ENABLED)
    expect(result).toMatchObject({ matchedMessages: 1, unsupportedLayouts: 1 })
    expect(result.body).toEqual(body([{ ...content[0], text: NEUTRAL + '\nKeep.' }, content[1]]))
  })

  it.each(['user', 'assistant', 'tool'])('leaves %s content unchanged', role => {
    const input = body(GUI_PARAGRAPH, role)
    expect(rewriteChannelIdentity(input, ENABLED).body).toBe(input)
  })

  it.each([
    { region: 'cn' as const, enabled: false },
    { region: 'global' as const, enabled: true },
    { region: 'global' as const, enabled: false },
  ])('bypasses both rules without copying: %j', options => {
    const input = freeze(body(ORIGINAL + '\n\n' + GUI_PARAGRAPH))
    expect(rewriteChannelIdentity(input, options).body).toBe(input)
  })
})

describe('array layout and bypass contract', () => {
  it('changes only the first meaningful text block, keeping metadata and images', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }
    const input = freeze(body([
      { type: 'text', text: '\uFEFF \n', tag: 'keep-whitespace' },
      { type: 'text', text: ORIGINAL + '\nKeep suffix.', tag: 'keep-metadata' },
      image,
      { type: 'text', text: ORIGINAL },
    ]))
    const result = rewriteChannelIdentity(input, ENABLED)
    expect(result.matchedMessages).toBe(1)
    expect(result.body).toEqual(body([
      { type: 'text', text: '\uFEFF \n', tag: 'keep-whitespace' },
      { type: 'text', text: NEUTRAL + '\nKeep suffix.', tag: 'keep-metadata' },
      image,
      { type: 'text', text: ORIGINAL },
    ]))
  })

  it('accepts a complete opener at the end of the sole text block', () => {
    expect(rewriteChannelIdentity(body([{ type: 'text', text: ORIGINAL }]), ENABLED).body)
      .toEqual(body([{ type: 'text', text: NEUTRAL }]))
  })

  it.each([
    [{ type: 'text', text: 'You are an AI agent powered by ' }, { type: 'text', text: 'DeepSeek Harness. Next.' }],
    [{ type: 'text', text: ORIGINAL }, { type: 'text', text: 'Ambiguous boundary.' }],
    [{ type: 'image_url', image_url: { url: 'fixture' } }, { type: 'text', text: ORIGINAL }],
    [{ type: 'unknown', text: '' }, { type: 'text', text: ORIGINAL }],
    [{ type: 'text', text: 42 }, { type: 'text', text: ORIGINAL }],
  ].map(content => ({ content })))('preserves unsupported layouts without merging or dropping blocks: $content', ({ content }) => {
    const input = freeze(body(content))
    const result = rewriteChannelIdentity(input, ENABLED)
    expect(result.body).toBe(input)
    expect(result.matchedMessages).toBe(0)
    expect(result.unsupportedLayouts).toBe(1)
  })

  it.each([null, undefined, 42, 'not a parsed body', [], {}, { messages: null }, body(null), body([])].map(input => ({ input })))(
    'preserves unknown or empty input $input', ({ input }) => {
      expect(rewriteChannelIdentity(input, ENABLED).body).toBe(input)
    },
  )

  it.each([
    { region: 'cn' as const, enabled: false },
    { region: 'global' as const, enabled: true },
  ])('bypasses without copying for %j', options => {
    const input = body(ORIGINAL)
    expect(rewriteChannelIdentity(input, options).body).toBe(input)
  })

  it('preserves unusual own keys and null/invalid messages', () => {
    const input = JSON.parse('{"__proto__":{"preserve":true},"messages":[null,7,{"role":"system","content":"'
      + ORIGINAL + '"}]}')
    const result = rewriteChannelIdentity(input, ENABLED)
    expect(Object.hasOwn(result.body as object, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>).preserve).toBeUndefined()
    expect(result.matchedMessages).toBe(1)
  })
})
