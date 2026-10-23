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
  options: { delaysMs?: readonly number[]; onSleep?: (index: number) => Promise<void> | void } = {},
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
