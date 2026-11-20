import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { prepareChatBody, prepareCnChatBody, WorkBuddyUpstreamClient } from '../src/upstream.ts'

const ORIGINAL = 'You are an AI agent powered by DeepSeek Harness.'
const NEUTRAL = 'You are an AI agent.'
const GUI = 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.'
const CURRENT_GUI = 'You are interacting with the user through the current Web GUI whose URL the runtime context names.'
const GUI_GUARD = 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.'
const FULL_SYSTEM = ORIGINAL + '\n\n' + GUI + ' ' + GUI_GUARD + ' Starting another server does not update this GUI.'
const CN: WorkBuddyCredential = {
  accessToken: 'fixture-at', refreshToken: 'fixture-rt', expiresAtMs: 0,
  domain: 'www.codebuddy.cn', uid: 'fixture-user', source: 'desktop',
}
const GLOBAL: WorkBuddyCredential = { ...CN, domain: 'www.workbuddy.ai' }

function client(enabled?: boolean): WorkBuddyUpstreamClient {
  return new WorkBuddyUpstreamClient({
    resolveChatIdentity: async () => ({ clientVersion: '5.8.3', cliVersion: '2.161.0' }),
    ...(enabled === undefined ? {} : { enableCnChannelCompat: enabled }),
  })
}

function capture() {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    return new Response('data: {"choices":[{"delta":{"content":"fixture"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    })
  }))
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('channel compatibility at the actual outbound fetch boundary', () => {
  it('applies R2 at the existing CN boundary while keeping all 63 tools, tool results and cancellation', async () => {
    const calls = capture()
    const signal = new AbortController().signal
    const prepared = prepareChatBody(JSON.stringify({
      model: 'hy3', max_tokens: 512, stream: true,
      tools: Array.from({ length: 63 }, (_, i) => ({ type: 'function', function: { name: `fixture_${i}`, parameters: { type: 'object' } } })),
      messages: [
        { role: 'developer', content: FULL_SYSTEM },
        { role: 'user', content: GUI },
        { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: GUI },
      ], unknown: { retained: true },
    }))
    await client(true).chatStream(CN, prepared, signal)
    expect(calls).toHaveLength(1)
    const expected = JSON.parse(prepareCnChatBody(prepared))
    expected.messages[0].content = FULL_SYSTEM.replace(ORIGINAL, NEUTRAL).replace(GUI, CURRENT_GUI)
    expect(calls[0]?.body).toEqual(expected)
    expect(calls[0]?.init.signal).toBe(signal)
  })

  it.each([false, undefined])('does not introduce R2 for standalone option %j', async enabled => {
    const calls = capture()
    await client(enabled).chatStream(CN, JSON.stringify({ model: 'hy3', messages: [{ role: 'system', content: FULL_SYSTEM }] }))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body.messages).toEqual([{ role: 'system', content: FULL_SYSTEM }])
  })

  it('keeps R2 out of international requests', async () => {
    const calls = capture()
    await client(true).chatStream(GLOBAL, JSON.stringify({ model: 'm', messages: [{ role: 'system', content: FULL_SYSTEM }] }))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body.messages).toEqual([{ role: 'system', content: FULL_SYSTEM }])
  })

  it('uses the same guarded conversion for auxiliary messages and a sole text block', async () => {
    const calls = capture()
    await client(true).chatStream(CN, prepareChatBody(JSON.stringify({ model: 'hy3', messages: [
      { role: 'system', content: FULL_SYSTEM },
      { role: 'system', content: [{ type: 'text', text: FULL_SYSTEM, tag: 'retain' }] },
      { role: 'user', content: 'Generate a title.' },
    ] })))
    expect(calls).toHaveLength(1)
    const next = FULL_SYSTEM.replace(ORIGINAL, NEUTRAL).replace(GUI, CURRENT_GUI)
    expect(calls[0]?.body.messages).toEqual([
      { role: 'system', content: next },
      { role: 'system', content: [{ type: 'text', text: next, tag: 'retain' }] },
      { role: 'user', content: 'Generate a title.' },
    ])
  })

  it('rewrites after the original transforms while retaining all other fields and cancellation', async () => {
    const calls = capture()
    const signal = new AbortController().signal
    const prepared = prepareChatBody(JSON.stringify({
      model: 'hy3', stream: false, max_tokens: 512, reasoning_effort: 'high',
      messages: [
        { role: 'developer', content: ORIGINAL + '\nKeep these instructions.' },
        { role: 'user', content: [{ type: 'text', text: 'Keep user content' }, { type: 'image_url', image_url: { url: 'fixture-image' } }] },
        { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'actual tool result' },
      ],
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
      tool_choice: { type: 'auto' }, unknown: { preserve: true },
    }))
    expect((await client(true).chatStream(CN, prepared, signal)).ok).toBe(true)
    expect(calls).toHaveLength(1)
    const expected = JSON.parse(prepareCnChatBody(prepared))
    expected.messages[0].content = NEUTRAL + '\nKeep these instructions.'
    expect(calls[0]?.body).toEqual(expected)
    expect(calls[0]?.url).toBe('https://copilot.tencent.com/v2/chat/completions')
    expect(calls[0]?.init.signal).toBe(signal)
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer fixture-at')
    expect(headers['X-Refresh-Token']).toBeUndefined()
  })

  it.each([false, undefined])('retains standalone-client behavior with option %j', async enabled => {
    const calls = capture()
    await client(enabled).chatStream(CN, JSON.stringify({ model: 'hy3', messages: [{ role: 'system', content: ORIGINAL }] }))
    expect(calls[0]?.body.messages).toEqual([{ role: 'system', content: ORIGINAL }])
  })

  it('never rewrites the international request even when the option is true', async () => {
    const calls = capture()
    await client(true).chatStream(GLOBAL, JSON.stringify({ model: 'm', messages: [{ role: 'system', content: ORIGINAL }] }))
    expect(calls[0]?.url).toBe('https://www.workbuddy.ai/v2/chat/completions')
    expect(calls[0]?.body.messages).toEqual([{ role: 'system', content: ORIGINAL }])
  })

  it('applies the same rule to a title-shaped auxiliary body and every system message', async () => {
    const calls = capture()
    await client(true).chatStream(CN, prepareChatBody(JSON.stringify({
      model: 'hy3', messages: [
        { role: 'system', content: ORIGINAL + '\nGenerate a short title.' },
        { role: 'system', content: [{ type: 'text', text: ORIGINAL + '\nKeep metadata.', tag: 'retain' }] },
        { role: 'user', content: 'Fixture title input' },
      ],
    })))
    expect(calls[0]?.body.messages).toEqual([
      { role: 'system', content: NEUTRAL + '\nGenerate a short title.' },
      { role: 'system', content: [{ type: 'text', text: NEUTRAL + '\nKeep metadata.', tag: 'retain' }] },
      { role: 'user', content: 'Fixture title input' },
    ])
  })

  it('keeps the existing unsupported-effort conversion and one-argument helper contract', () => {
    const source = JSON.stringify({ reasoning_effort: 'off', messages: [{ role: 'system', content: ORIGINAL }] })
    expect(JSON.parse(prepareCnChatBody(source))).toEqual({ messages: [{ role: 'system', content: ORIGINAL }] })
    expect(JSON.parse(prepareCnChatBody(source, { enableCnChannelCompat: true })))
      .toEqual({ messages: [{ role: 'system', content: NEUTRAL }] })
    expect(prepareCnChatBody('not json', { enableCnChannelCompat: true })).toBe('not json')
  })

  it('uses the shared rule for probes without changing their no-match payload', async () => {
    const calls = capture()
    const signal = new AbortController().signal
    const a = await client(false).probeEffort(CN, 'hy3', 'high', signal)
    const b = await client(true).probeEffort(CN, 'hy3', 'high', signal)
    expect(a.streamed).toBe(true)
    expect(b.streamed).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.body).toEqual(calls[1]?.body)
    expect(calls[1]?.init.signal).toBe(signal)
  })
})
