/**
 * The retry loop around a channel refusal.
 *
 * These cases exist because the loop is the one place where a diagnostic
 * verdict turns into repeated upstream traffic: it must retry *only* a channel
 * refusal, must stop the moment the caller has gone, and must not turn one 400
 * into three for a failure class that is a statement about the account.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkBuddyCredentialStore } from '../src/auth.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyChatResult, UpstreamErrorKind } from '../src/upstream.ts'

const CLEANUP: Array<() => Promise<void>> = []

/** One attempt the shim forwarded, with the attempt label it passed down. */
interface Attempt {
  body: string
  attempt: number | undefined
}

interface Fixture {
  shim: WorkBuddyShim
  attempts: Attempt[]
  /** Waits the loop asked for, in order; the injected sleep records instead of waiting. */
  waits: number[]
  retries: Array<{ attempt: number; delayMs: number; kind: string }>
}

/**
 * Build a shim whose upstream answers are scripted.
 *
 * The sleep is injected so a case can assert the backoff values without waiting
 * for them, and so a case can simulate the caller disconnecting *during* the
 * wait — the ordering that a real timer makes awkward to hit deterministically.
 */
async function startShim(
  answers: readonly WorkBuddyChatResult[],
  options: {
    delaysMs?: readonly number[]
    onSleep?: (index: number) => Promise<void> | void
    /** Report the compat path as enabled, as the real client does in production. */
    compat?: boolean
  } = {},
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-retry-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  const desktop = join(dir, 'workbuddy-desktop.info')
  await writeFile(desktop, JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, domain: 'www.codebuddy.cn' },
    account: { uid: 'uid-retry' },
  }))
  const store = new WorkBuddyCredentialStore({
    desktopPath: desktop,
    ownPath: join(dir, 'own.json'),
    refresh: async () => ({ accessToken: 'unused' }),
  })
  const fixture: Fixture = {
    shim: undefined as unknown as WorkBuddyShim,
    attempts: [],
    waits: [],
    retries: [],
  }
  let cursor = 0
  fixture.shim = createWorkBuddyShim({
    store,
    catalog: new WorkBuddyCatalog(),
    client: {
      channelCompatEnabled: options.compat === true,
      async chatStream(_credential, bodyJson, _signal, context): Promise<WorkBuddyChatResult> {
        fixture.attempts.push({ body: bodyJson, attempt: context?.attempt })
        const answer = answers[Math.min(cursor, answers.length - 1)]
        cursor++
        return answer ?? { ok: false, status: 500, kind: 'server', message: 'script exhausted' }
      },
    },
    channelRetry: {
      ...options.delaysMs === undefined ? {} : { delaysMs: options.delaysMs },
      sleep: async ms => {
        fixture.waits.push(ms)
        await options.onSleep?.(fixture.waits.length - 1)
      },
      onRetry: info => fixture.retries.push(info),
    },
  })
  await fixture.shim.ready
  CLEANUP.push(() => fixture.shim.close())
  return fixture
}

/** The refusal envelope the upstream actually sends, classified by the client. */
const refused = (): WorkBuddyChatResult => ({
  ok: false,
  status: 400,
  kind: 'channel_rejected',
  message: 'Illegal API invocation from an unapproved channel',
})

const answered = (): WorkBuddyChatResult => ({
  ok: true,
  response: new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }),
})

const failed = (kind: UpstreamErrorKind, status: number): WorkBuddyChatResult => ({
  ok: false,
  status,
  kind,
  message: `fixture ${kind}`,
})

/** POST one chat completion through the shim, as the adaptor would. */
async function post(fixture: Fixture): Promise<Response> {
  return fetch(`${fixture.shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${fixture.shim.token()}` },
    body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'fixture' }] }),
  })
}

/** POST an arbitrary body, for cases that care about the message roles. */
async function postBody(fixture: Fixture, body: unknown): Promise<Response> {
  return fetch(`${fixture.shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${fixture.shim.token()}` },
    body: JSON.stringify(body),
  })
}

const HARNESS_BODY = {
  model: 'hy3',
  messages: [
    { role: 'system', content: 'Long harness instructions.' },
    { role: 'user', content: 'hello' },
  ],
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(async () => {
  while (CLEANUP.length > 0) await CLEANUP.pop()!()
})

describe('channel-refusal retry', () => {
  it('retries twice with the documented backoff, then answers the refusal it last saw', async () => {
    const fixture = await startShim([refused(), refused(), refused()])
    const response = await post(fixture)
    expect(response.status).toBe(400)
    const body = await response.json() as { error: { code: string } }
    expect(body.error.code).toBe('channel_rejected')
    expect(fixture.attempts).toHaveLength(3)
    expect(fixture.attempts.map(attempt => attempt.attempt)).toEqual([0, 1, 2])
    expect(fixture.waits).toEqual([500, 2_000])
    expect(fixture.retries).toEqual([
      { attempt: 1, delayMs: 500, kind: 'channel_rejected' },
      { attempt: 2, delayMs: 2_000, kind: 'channel_rejected' },
    ])
  })

  it('recovers when a later attempt answers, and streams that answer', async () => {
    const fixture = await startShim([refused(), answered()])
    const response = await post(fixture)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('[DONE]')
    expect(fixture.attempts).toHaveLength(2)
    expect(fixture.waits).toEqual([500])
  })

  it.each([
    { kind: 'hard_credit' as const, status: 402 },
    { kind: 'session_dead' as const, status: 401 },
    { kind: 'soft_rate' as const, status: 429 },
    { kind: 'server' as const, status: 502 },
    { kind: 'client' as const, status: 400 },
  ])('does not retry $kind ($status)', async ({ kind, status }) => {
    const fixture = await startShim([failed(kind, status)])
    const response = await post(fixture)
    expect(fixture.attempts).toHaveLength(1)
    expect(fixture.waits).toEqual([])
    expect(response.status).not.toBe(0)
  })

  it('attempts once when the policy is empty', async () => {
    const fixture = await startShim([refused()], { delaysMs: [] })
    const response = await post(fixture)
    expect(response.status).toBe(400)
    expect(fixture.attempts).toHaveLength(1)
    expect(fixture.waits).toEqual([])
  })

  it('stops retrying when the caller disconnects during the wait', async () => {
    const fixture = await startShim([refused(), answered()], {
      // Abort the request while the loop waits, then let the server observe the
      // closed socket: the caller is gone, so the retry would be billed for
      // nobody and the shim must not send it. Waiting here (rather than the loop
      // racing the event loop) is what makes the assertion about the *decision*
      // instead of about timing.
      onSleep: async () => {
        controller.abort()
        await new Promise(resolve => setTimeout(resolve, 50))
      },
    })
    const controller = new AbortController()
    const request = fetch(`${fixture.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${fixture.shim.token()}` },
      body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'fixture' }] }),
      signal: controller.signal,
    })
    await expect(request).rejects.toThrow()
    // Give the handler a turn to observe the abort it triggered on `res`.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fixture.attempts).toHaveLength(1)
  })
})

/**
 * The measured cause of the CN refusal is the system role's *content*, not a
 * transient fault, so the first reaction is to change the body rather than the
 * timing: the same text in a leading user turn answered 200 on the wire.
 */
describe('system-prompt relocation fallback', () => {
  it('moves the system prompt into a user turn and retries immediately', async () => {
    const fixture = await startShim([refused(), answered()], { delaysMs: [], compat: true })
    const response = await postBody(fixture, HARNESS_BODY)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('[DONE]')
    expect(fixture.attempts).toHaveLength(2)
    // No backoff was waited: the retry changed the body, not the timing.
    expect(fixture.waits).toEqual([])
    expect(fixture.retries).toEqual([{ attempt: 1, delayMs: 0, kind: 'channel_rejected' }])
    const relocated = JSON.parse(fixture.attempts[1]!.body) as { messages: Array<{ role: string; content: string }> }
    expect(relocated.messages[0]).toEqual({ role: 'system', content: 'You are a helpful AI assistant.' })
    expect(relocated.messages[1]?.role).toBe('user')
    expect(relocated.messages[1]?.content).toContain('Long harness instructions.')
    expect(relocated.messages[2]).toEqual({ role: 'user', content: 'hello' })
  })

  it('keeps the original body when compat is disabled', async () => {
    const fixture = await startShim([refused(), answered()], { delaysMs: [] })
    const response = await postBody(fixture, HARNESS_BODY)
    expect(response.status).toBe(400)
    expect(fixture.attempts).toHaveLength(1)
    expect((JSON.parse(fixture.attempts[0]!.body) as { messages: unknown }).messages).toEqual(HARNESS_BODY.messages)
  })

  it('falls back to the configured backoff when relocation does not help', async () => {
    const fixture = await startShim([refused(), refused(), answered()], { compat: true })
    const response = await postBody(fixture, HARNESS_BODY)
    expect(response.status).toBe(200)
    // attempt 0 original, attempt 1 relocated, attempt 2 relocated + 500ms wait.
    expect(fixture.attempts.map(attempt => attempt.attempt)).toEqual([0, 1, 2])
    expect(fixture.waits).toEqual([500])
    expect(fixture.attempts[2]!.body).toBe(fixture.attempts[1]!.body)
  })

  it('does not relocate a body with no system message', async () => {
    const fixture = await startShim([refused(), refused()], { delaysMs: [], compat: true })
    const response = await postBody(fixture, { model: 'hy3', messages: [{ role: 'user', content: 'only' }] })
    expect(response.status).toBe(400)
    expect(fixture.attempts).toHaveLength(1)
  })
})
