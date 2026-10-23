/**
 * `workbuddy status` channel-compat reporting from a boot-free process.
 *
 * The CLI cannot see the host's memory, so the ledger is the only evidence it
 * has. These cases pin the two things a user reads it for: whether the prompt
 * rewrite was on in the request that got refused, and what that request looked
 * like before/after the rewrite. The auth file is pointed at an absent path so
 * the run stays offline and lands in the signed-out branch, which still carries
 * the compat section.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { run } from '../src/bin.ts'
import { WIRE_CAPTURE_DIRNAME } from '../src/wire-capture.ts'

const CLEANUP: Array<() => Promise<void>> = []
const ORIGINAL_ENV = { ...process.env }

/** One captured request: rewritten 8740 → 8703, then refused. */
const RECORD = {
  schemaVersion: 1,
  at: '2026-10-22T02:52:57.926Z',
  provider: 'workbuddy',
  kind: 'chat',
  request: {
    provider: 'workbuddy',
    region: 'cn',
    url: 'https://copilot.tencent.com/v2/chat/completions',
    method: 'POST',
    headers: { authorization: 'len=38 tail=1234' },
    bodyBytes: 12_345,
    bodySha256: 'a'.repeat(64),
    body: { model: 'hy3', maxTokens: 64_000, messageCount: 6, roles: ['system', 'user'], toolCount: 63, stream: true },
    identity: { clientVersion: '5.8.3', cliVersion: '2.161.0', userAgent: 'WorkBuddy/5.8.3' },
    compat: {
      ruleVersion: 'cn-dsh-compat-v3',
      region: 'cn',
      enabled: true,
      systemMessages: 1,
      matchedMessages: 1,
      unsupportedLayouts: 0,
      lastSystem: {
        opener: 'changed',
        gui: 'changed',
        charsBefore: 8740,
        charsAfter: 8703,
        paragraphs: 23,
        guiOriginalCount: 1,
        neutralCount: 1,
        lastParagraphHead: 'You are interacting with the user through the DeepSeek Harness Web GUI',
        changed: true,
      },
    },
    attempt: 2,
  },
  result: { status: 400, kind: 'channel_rejected', code: 11128, durationMs: 1_234 },
}

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-cli-status-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function writeLedger(home: string): Promise<void> {
  const dir = join(home, WIRE_CAPTURE_DIRNAME)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'workbuddy-2026-10-22.jsonl'), `${JSON.stringify(RECORD)}\n`)
}

/** Run the CLI and capture stdout; `--json` and the human form share this. */
async function capture(args: readonly string[]): Promise<{ code: number, json: Record<string, unknown>, text: string }> {
  const writes: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  })
  try {
    const code = await run([...args])
    const text = writes.join('')
    return { code, json: text.trimStart().startsWith('{') ? JSON.parse(text) as Record<string, unknown> : {}, text }
  } finally {
    spy.mockRestore()
  }
}

beforeEach(() => {
  // Signed out on purpose: no network, and the compat section must still answer.
  process.env = { ...ORIGINAL_ENV }
})

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV }
  while (CLEANUP.length > 0) await CLEANUP.pop()!()
})

describe('status channel compat from the ledger', () => {
  it('reports the captured decision in --json', async () => {
    const home = await tempHome()
    process.env.DSH_HOME = home
    process.env.WORKBUDDY_AUTH_FILE = join(home, 'absent-desktop.info')
    process.env.DSH_WORKBUDDY_CAPTURE = '1'
    await writeLedger(home)
    const { json } = await capture(['status', '--json'])
    const compat = json['channelCompat'] as Record<string, unknown>
    expect(compat).toMatchObject({
      captureEnabled: true,
      enabled: true,
      ruleVersion: 'cn-dsh-compat-v3',
      lastStatus: 400,
      lastOutcome: 'channel_rejected',
      model: 'hy3',
      systemCharsBefore: 8740,
      systemCharsAfter: 8703,
      opener: 'changed',
      gui: 'changed',
    })
    expect(compat['lastRequestAt']).toBe('2026-10-22T02:52:57.926Z')
    expect(compat['captureDir']).toBe(join(home, WIRE_CAPTURE_DIRNAME))
    // Nothing secret or bulky leaves the ledger.
    expect(JSON.stringify(json)).not.toContain('Bearer')
    expect(JSON.stringify(json)).not.toContain('a'.repeat(64))
  })

  it('reports the same facts in the human form', async () => {
    const home = await tempHome()
    process.env.DSH_HOME = home
    process.env.WORKBUDDY_AUTH_FILE = join(home, 'absent-desktop.info')
    process.env.DSH_WORKBUDDY_CAPTURE = '1'
    await writeLedger(home)
    const { text } = await capture(['status'])
    expect(text).toContain('Channel compat: prompt rewrite on (cn-dsh-compat-v3) · model hy3 · last request 2026-10-22T02:52:57.926Z → 400 channel_rejected')
    expect(text).toContain('system prompt: 8740 → 8703 chars · opener changed · gui changed')
    expect(text).toContain('last paragraph starts: "You are interacting with the user through the DeepSeek Harness Web GUI"')
    expect(text).toContain('Capture: on → ')
  })

  it('says nothing was captured rather than implying the patch is off', async () => {
    const home = await tempHome()
    process.env.DSH_HOME = home
    process.env.WORKBUDDY_AUTH_FILE = join(home, 'absent-desktop.info')
    delete process.env.DSH_WORKBUDDY_CAPTURE
    const human = await capture(['status'])
    expect(human.text).toContain('Channel compat: no captured request yet')
    expect(human.text).toContain('Capture: off (run `capture on`, or start the host with DSH_WORKBUDDY_CAPTURE=1')
    // "not captured" must never masquerade as "rewrite disabled".
    const { json } = await capture(['status', '--json'])
    const compat = json['channelCompat'] as Record<string, unknown>
    expect(compat).not.toHaveProperty('enabled')
    expect(compat).not.toHaveProperty('lastStatus')
    expect(compat['captureEnabled']).toBe(false)
  })
})
