import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSystemMessage, createUserMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { createWorkBuddyAdapter } from '../src/adapter.ts'
import { WorkBuddyCredentialStore } from '../src/auth.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { classifyUpstreamError, WorkBuddyUpstreamClient } from '../src/upstream.ts'

const MESSAGE = 'Illegal API invocation from an unapproved channel'
const TIPS = '这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。'
const envelope = (extra: Record<string, unknown> = {}) => JSON.stringify({ code: 11128, msg: MESSAGE, ...extra })
const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'fixture-at', refreshToken: 'fixture-rt', expiresAtMs: 0,
  domain: 'www.codebuddy.cn', uid: 'fixture-user', source: 'desktop',
}
const client = () => new WorkBuddyUpstreamClient({
  resolveChatIdentity: async () => ({ clientVersion: '5.8.3' }),
})

afterEach(() => vi.unstubAllGlobals())

describe('structured channel rejection classification', () => {
  it.each([11128, '11128'])('requires a known channel signal as well as code %j', code => {
    expect(classifyUpstreamError(400, envelope({ code }))).toBe('channel_rejected')
  })

  it('recognizes the exact localized channel hint', () => {
    expect(classifyUpstreamError(400, envelope({ msg: 'opaque', displayTips: { zh: TIPS } }))).toBe('channel_rejected')
  })

  it.each([
    { code: 11128, msg: 'first message is not system prompt' },
    { code: 11128, displayMsg: { zh: '请求被拦截，请重新发送' } },
    { code: 11128, msg: 'quoted example: ' + MESSAGE },
    { code: 11128, data: { msg: MESSAGE } },
    { code: '011128', msg: MESSAGE },
    { code: 11133, msg: MESSAGE },
    { msg: MESSAGE },
  ])('does not infer a channel refusal from an insufficient envelope %j', value => {
    expect(classifyUpstreamError(400, JSON.stringify(value))).toBe('client')
  })

  it('keeps ordinary errors and existing precedence', () => {
    expect(classifyUpstreamError(400, 'bad json mentioning ' + MESSAGE)).toBe('client')
    expect(classifyUpstreamError(200, envelope())).toBe('client')
    expect(classifyUpstreamError(401, envelope())).toBe('session_dead')
    expect(classifyUpstreamError(402, envelope())).toBe('hard_credit')
    expect(classifyUpstreamError(429, envelope())).toBe('soft_rate')
    expect(classifyUpstreamError(503, envelope())).toBe('server')
  })

  it('redacts the channel error returned by the real client without extra requests', async () => {
    const fetchMock = vi.fn(async () => new Response(envelope({ diagnostic: 'DO_NOT_EXPOSE_401_403_fixture' }), { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await client().chatStream(CREDENTIAL, JSON.stringify({ model: 'hy3', messages: [] }))
    expect(result).toMatchObject({ ok: false, status: 400, kind: 'channel_rejected' })
    if (result.ok) throw new Error('expected channel failure')
    expect(result.message).toContain('渠道')
    expect(result.message).not.toMatch(/DO_NOT_EXPOSE|401|403|fixture-at/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('redacts the same error on the probe path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(envelope({ diagnostic: 'DO_NOT_EXPOSE_fixture' }), { status: 400 })))
    const result = await client().probeEffort(CREDENTIAL, 'hy3', 'high', new AbortController().signal)
    expect(result.status).toBe(400)
    expect(result.detail).toContain('渠道')
    expect(result.detail).not.toContain('DO_NOT_EXPOSE')
  })

  it('crosses the real SDK and shim once and surfaces the default non-retryable request class', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-channel-adapter-'))
    const desktop = join(dir, 'desktop.info')
    await writeFile(desktop, JSON.stringify({ auth: {
      accessToken: 'fixture-at', expiresAt: Date.now() + 3_600_000, domain: 'www.codebuddy.cn',
    }, account: { uid: 'fixture-user' } }))
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop, ownPath: join(dir, 'absent-own.json'),
      refresh: async () => { throw new Error('unexpected fixture refresh') },
    })
    const catalog = new WorkBuddyCatalog([{
      id: 'hy3', name: 'Fixture', contextWindow: 100_000, maxTokens: 512,
      supportsImages: false, billing: { free: false },
    }])
    // No retries here on purpose: this case pins the *classification* reaching
    // the SDK, and a retrying shim would turn one upstream 400 into three. The
    // retry loop has its own spec (channel-retry.spec.ts).
    const shim = createWorkBuddyShim({ store, catalog, client: client(), channelRetry: { delaysMs: [] } })
    const realFetch = globalThis.fetch
    let upstreamRequests = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init)
      expect(String(url)).toBe('https://copilot.tencent.com/v2/chat/completions')
      upstreamRequests++
      return new Response(envelope({ diagnostic: 'DO_NOT_EXPOSE_401_403_fixture' }), { status: 400 })
    }))
    try {
      await shim.ready
      const adapter = createWorkBuddyAdapter({ store, catalog, shim }).adapter
      const call = await adapter.prepareCall('workbuddy', 'hy3')
      const chunks: unknown[] = []
      for await (const chunk of call.stream({
        provider: 'workbuddy', model: 'hy3',
        messages: [
          createSystemMessage('Fixture system prompt'),
          createUserMessage({ content: [{ type: 'text', text: 'Fixture user prompt' }], source: { kind: 'user' } }),
        ],
      })) chunks.push(chunk)
      const finish = chunks.find(chunk => (chunk as { type?: string }).type === 'finish')
      expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST' } } })
      expect(JSON.stringify(finish)).not.toMatch(/DO_NOT_EXPOSE|401|403|fixture-at/)
      expect(upstreamRequests).toBe(1)
      const policy = resolveRetryPolicy(undefined, 'workbuddy.channel-rejection.fixture')
      expect(policy.mode).toBe('normal')
      if (policy.mode === 'normal') expect(policy.retryableCodes).not.toContain('INVALID_REQUEST')
      // The complete host failed-step recovery extension is verified in P4/P6.
    } finally {
      await shim.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
