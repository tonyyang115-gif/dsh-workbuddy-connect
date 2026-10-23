/**
 * The opt-in wire capture and the compat digest it records.
 *
 * The value of this module is entirely in what it refuses to write: a ledger
 * that stored the bearer or the message text would be a liability on the user's
 * disk, and one that stored too little could not answer the question it exists
 * for. Both halves are asserted, plus the redaction of the one header that
 * carries a secret.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digestChannelCompat, rewriteChannelIdentity } from '../src/channel-compat.ts'
import {
  clearWireCaptureMarker,
  flushWireCapture,
  readWireCaptureMarker,
  readWireLedgerTail,
  recordWireEvent,
  redactAuthorization,
  redactHeaders,
  resetWireCapture,
  setWireCapture,
  wireCaptureDir,
  wireCaptureEnabled,
  wireCaptureFile,
  wireCaptureState,
  WIRE_CAPTURE_MARKER,
} from '../src/wire-capture.ts'
import { WorkBuddyUpstreamClient } from '../src/upstream.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

const CLEANUP: Array<() => Promise<void>> = []
const ORIGINAL_ENV = { ...process.env }

/** A directory that never exists, so the switch sees "no marker file". */
const ABSENT_DIR = join(tmpdir(), 'dsh-workbuddy-absent-marker-dir')

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-capture-marker-'))
  CLEANUP.push(async () => rm(dir, { recursive: true, force: true }))
  return dir
}

const GUI_SENTENCE = 'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.'
const GUI_GUARD = 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.'
const OPENER = 'You are an AI agent powered by DeepSeek Harness. Read once; it applies to every turn of this session.'

/** A system prompt whose last paragraph starts with the GUI sentence, as production ships it. */
const SYSTEM = [
  OPENER,
  '',
  'Working directory: /tmp/fixture',
  '',
  `${GUI_SENTENCE} ${GUI_GUARD}`,
].join('\n')

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'fixture-secret-token-value-1234',
  refreshToken: 'fixture-refresh',
  expiresAtMs: Date.now() + 3_600_000,
  domain: 'www.codebuddy.cn',
  uid: 'fixture-uid',
  source: 'desktop',
}

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-wire-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

beforeEach(() => {
  resetWireCapture()
})

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV }
  resetWireCapture()
  while (CLEANUP.length > 0) await CLEANUP.pop()!()
  vi.unstubAllGlobals()
})

describe('capture switch', () => {
  // Every case here passes an explicit directory: the switch reads a real file
  // in the DSH home, so a test that fell back to the default would consult the
  // developer's own marker and pass or fail with their settings.
  it.each([
    ['1', true], ['true', true], ['TRUE', true], ['yes', true], ['on', true], [' 1 ', true],
    ['0', false], ['false', false], ['', false], ['enabled', false],
  ])('reads %j as %s', (value, expected) => {
    expect(wireCaptureEnabled({ DSH_WORKBUDDY_CAPTURE: value }, ABSENT_DIR)).toBe(expected)
  })

  it('is off when the variable is absent', () => {
    expect(wireCaptureEnabled({}, ABSENT_DIR)).toBe(false)
  })
})

describe('capture marker file', () => {
  it('turns the capture on with nothing set in the environment', async () => {
    const dir = await tempDir()
    setWireCapture(true, dir)
    expect(wireCaptureState({}, dir)).toMatchObject({ enabled: true, source: 'marker' })
  })

  it('turns it off even when the environment says on, without a restart', async () => {
    const dir = await tempDir()
    setWireCapture(true, dir)
    expect(wireCaptureEnabled({ DSH_WORKBUDDY_CAPTURE: '1' }, dir)).toBe(true)
    setWireCapture(false, dir)
    expect(wireCaptureState({ DSH_WORKBUDDY_CAPTURE: '1' }, dir)).toMatchObject({ enabled: false, source: 'marker' })
  })

  it('treats a touched empty file as on, and lets the environment decide once it is gone', async () => {
    const dir = await tempDir()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, WIRE_CAPTURE_MARKER), '', 'utf8')
    expect(wireCaptureEnabled({}, dir)).toBe(true)
    clearWireCaptureMarker(dir)
    expect(wireCaptureState({ DSH_WORKBUDDY_CAPTURE: '1' }, dir)).toMatchObject({ enabled: true, source: 'env' })
    expect(wireCaptureState({}, dir)).toMatchObject({ enabled: false, source: 'default' })
  })

  it.each(['off', 'OFF', ' 0 ', 'false', 'no', 'disabled'])('reads marker content %j as off', async content => {
    const dir = await tempDir()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, WIRE_CAPTURE_MARKER), content, 'utf8')
    expect(wireCaptureEnabled({ DSH_WORKBUDDY_CAPTURE: '1' }, dir)).toBe(false)
  })

  it('stops writing to the ledger as soon as the marker says off', async () => {
    const dir = await tempDir()
    setWireCapture(true, dir)
    expect(wireCaptureEnabled({}, dir)).toBe(true)
    setWireCapture(false, dir)
    expect(wireCaptureEnabled({}, dir)).toBe(false)
    expect(readWireCaptureMarker(dir)).toBe(false)
  })
})

describe('redaction', () => {
  it('keeps only the length and last four characters of a bearer', () => {
    expect(redactAuthorization('Bearer fixture-secret-token-value-1234')).toBe('len=38 tail=1234')
    expect(redactAuthorization('short')).toBe('len=5 tail=hort')
    expect(redactAuthorization('abc')).toBe('len=3 tail=n/a')
    expect(redactAuthorization(undefined)).toBe('absent')
    expect(redactAuthorization('')).toBe('absent')
  })

  it('never emits the token, even in a header dump', () => {
    const headers = redactHeaders({
      'Authorization': 'Bearer fixture-secret-token-value-1234',
      'User-Agent': 'WorkBuddy/5.8.3 WorkBuddy/5.8.3',
      'X-Requested-With': undefined,
      'X-Long': 'x'.repeat(500),
    })
    expect(headers['authorization']).toBe('len=38 tail=1234')
    expect(JSON.stringify(headers)).not.toContain('fixture-secret-token-value')
    expect(headers['user-agent']).toBe('WorkBuddy/5.8.3 WorkBuddy/5.8.3')
    expect(headers).not.toHaveProperty('x-requested-with')
    expect(headers['x-long']).toHaveLength(200)
  })
})

describe('compat digest', () => {
  const body = () => ({
    model: 'hy3',
    max_tokens: 64_000,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'fixture' }],
  })

  it('reports both rules firing when the layout matches', () => {
    const digest = digestChannelCompat(body(), { region: 'cn', enabled: true })
    expect(digest.enabled).toBe(true)
    expect(digest.matchedMessages).toBe(1)
    expect(digest.unsupportedLayouts).toBe(0)
    expect(digest.lastSystem?.opener).toBe('changed')
    expect(digest.lastSystem?.gui).toBe('changed')
    expect(digest.lastSystem?.changed).toBe(true)
    expect(digest.lastSystem?.charsAfter).toBeLessThan(digest.lastSystem?.charsBefore ?? 0)
    expect(digest.lastSystem?.guiOriginalCount).toBe(1)
    expect(digest.lastSystem?.neutralCount).toBe(1)
    expect(digest.markers?.after['DeepSeek Harness']).toBeLessThan(digest.markers?.before['DeepSeek Harness'] ?? 0)
  })

  it('reports nothing changed when the switch is off, matching the rewrite it delegates to', () => {
    const off = digestChannelCompat(body(), { region: 'cn', enabled: false })
    expect(off.enabled).toBe(false)
    expect(off.matchedMessages).toBe(0)
    expect(off.lastSystem?.changed).toBe(false)
    expect(off.lastSystem?.opener).toBe('unchanged')
    // The descriptor must agree with the rewrite, not just with itself.
    const applied = rewriteChannelIdentity(body(), { region: 'cn', enabled: false })
    expect(applied.matchedMessages).toBe(0)
  })

  it('reports a candidate the rules declined, without claiming a rewrite', () => {
    // The sentence is there but not in the trailing-paragraph shape R2 matches;
    // the digest must show the candidate and `false` rather than silently
    // reporting a clean prompt.
    const digest = digestChannelCompat({
      messages: [{ role: 'system', content: `Leading prose.\n\n${GUI_SENTENCE}` }],
    }, { region: 'cn', enabled: true })
    expect(digest.lastSystem?.gui).toBe('unchanged')
    expect(digest.lastSystem?.guiOriginalCount).toBe(1)
    expect(digest.lastSystem?.neutralCount).toBe(0)
    expect(digest.lastSystem?.changed).toBe(false)
  })

  it('calls out an ambiguous layout instead of guessing which sentence to rewrite', () => {
    const digest = digestChannelCompat({
      messages: [{ role: 'system', content: `a\n\n${GUI_SENTENCE} ${GUI_GUARD}\n\n${GUI_SENTENCE} ${GUI_GUARD}` }],
    }, { region: 'cn', enabled: true })
    expect(digest.lastSystem?.gui).toBe('unsupported')
    expect(digest.lastSystem?.guiOriginalCount).toBe(2)
    expect(digest.lastSystem?.changed).toBe(false)
  })
})

describe('ledger', () => {
  it('round-trips one record and reads the newest line per provider', async () => {
    const dir = await tempHome()
    await recordWireEvent({ schemaVersion: 1, at: '2026-10-22T03:00:00.000Z', provider: 'workbuddy', kind: 'chat', result: { status: 400 } }, dir)
    await recordWireEvent({ schemaVersion: 1, at: '2026-10-22T03:01:00.000Z', provider: 'workbuddy-ai', kind: 'chat', result: { status: 200 } }, dir)
    await recordWireEvent({ schemaVersion: 1, at: '2026-10-22T03:02:00.000Z', provider: 'workbuddy', kind: 'chat', result: { status: 200 } }, dir)

    const tail = await readWireLedgerTail('workbuddy', dir)
    expect(tail?.record.result?.status).toBe(200)
    expect(tail?.file).toBe(wireCaptureFile(new Date('2026-10-22T03:02:00.000Z'), dir))
    expect((await readWireLedgerTail('workbuddy-ai', dir))?.record.result?.status).toBe(200)
    expect(await readWireLedgerTail('workbuddy', join(dir, 'absent'))).toBeUndefined()
  })

  it('writes valid whole lines under the default directory', async () => {
    process.env.DSH_HOME = await tempHome()
    const dir = wireCaptureDir()
    await recordWireEvent({ schemaVersion: 1, at: new Date().toISOString(), provider: 'workbuddy', kind: 'chat' })
    const text = await readFile(wireCaptureFile(new Date(), dir), 'utf8')
    expect(text.trimEnd().split('\n')).toHaveLength(1)
    expect(() => JSON.parse(text.trimEnd())).not.toThrow()
  })
})

describe('capture on a real client request', () => {
  it('records the decision and the refusal without either secret', async () => {
    process.env.DSH_HOME = await tempHome()
    process.env.DSH_WORKBUDDY_CAPTURE = '1'
    const dir = wireCaptureDir()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' }),
      { status: 400 },
    )))
    const client = new WorkBuddyUpstreamClient({
      enableCnChannelCompat: true,
      provider: 'workbuddy',
      resolveChatIdentity: async () => ({ clientVersion: '5.8.3', cliVersion: '2.161.0' }),
    })
    const result = await client.chatStream(CREDENTIAL, JSON.stringify({
      model: 'hy3',
      stream: true,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'fixture' }],
      tools: [{ type: 'function', function: { name: 'fixture' } }],
    }), undefined, { attempt: 1 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('fixture expected a refusal')
    expect(result.kind).toBe('channel_rejected')
    expect(client.channelCompatEnabled).toBe(true)
    expect(client.providerId).toBe('workbuddy')

    await flushWireCapture()
    const tail = await readWireLedgerTail('workbuddy', dir)
    expect(tail).toBeDefined()
    const request = tail!.record.request!
    expect(request.region).toBe('cn')
    expect(request.url).toBe('https://copilot.tencent.com/v2/chat/completions')
    expect(request.headers['authorization']).toBe('len=38 tail=1234')
    expect(request.bodySha256).toMatch(/^[0-9a-f]{64}$/)
    expect(request.body?.toolCount).toBe(1)
    expect(request.body?.roles).toEqual(['system', 'user'])
    expect(request.compat?.enabled).toBe(true)
    expect(request.compat?.lastSystem?.gui).toBe('changed')
    expect(request.attempt).toBe(1)
    expect(tail!.record.result).toMatchObject({ status: 400, kind: 'channel_rejected', code: 11128 })

    const raw = await readFile(tail!.file, 'utf8')
    expect(raw).not.toContain('fixture-secret-token-value')
    expect(raw).not.toContain(GUI_SENTENCE)
    expect(raw).not.toContain('"fixture"')
  })

  it('writes nothing when the switch is off, and still reports the decision in memory', async () => {
    process.env.DSH_HOME = await tempHome()
    delete process.env.DSH_WORKBUDDY_CAPTURE
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const client = new WorkBuddyUpstreamClient({
      enableCnChannelCompat: true,
      resolveChatIdentity: async () => ({ clientVersion: '5.8.3' }),
    })
    const result = await client.chatStream(CREDENTIAL, JSON.stringify({
      messages: [{ role: 'system', content: SYSTEM }],
    }))
    expect(result.ok).toBe(true)
    await flushWireCapture()
    expect(await readWireLedgerTail('workbuddy', wireCaptureDir())).toBeUndefined()
  })
})
