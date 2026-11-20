/**
 * `capture on|off|status`: the switch a user can actually reach.
 *
 * The environment variable only exists at host start, so it cannot be the
 * answer to "how do I turn this off now". These cases pin the marker file as
 * the live switch, including the one ordering that matters: a host started with
 * `DSH_WORKBUDDY_CAPTURE=1` must be silenceable without quitting the app.
 *
 * The DSH home is a temp directory throughout, so the run touches neither the
 * developer's marker nor their real ledger.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { run } from '../src/bin.ts'
import { WIRE_CAPTURE_DIRNAME, WIRE_CAPTURE_MARKER } from '../src/wire-capture.ts'

const CLEANUP: Array<() => Promise<void>> = []
const ORIGINAL_ENV = { ...process.env }

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-cli-capture-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Run the CLI and capture both output streams. */
async function cli(args: readonly string[]): Promise<{ code: number, json: Record<string, unknown>, text: string, errors: string }> {
  const writes: string[] = []
  const errors: string[] = []
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  })
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    errors.push(String(chunk))
    return true
  })
  try {
    const code = await run([...args])
    const text = writes.join('')
    return {
      code,
      text,
      errors: errors.join(''),
      json: text.trimStart().startsWith('{') ? JSON.parse(text) as Record<string, unknown> : {},
    }
  } finally {
    out.mockRestore()
    err.mockRestore()
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function markerOf(home: string): string {
  return join(home, WIRE_CAPTURE_DIRNAME, WIRE_CAPTURE_MARKER)
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
  delete process.env.DSH_WORKBUDDY_CAPTURE
})

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV }
  while (CLEANUP.length > 0) await CLEANUP.pop()!()
})

describe('capture on/off', () => {
  it('creates the marker so the very next request is recorded, with no restart', async () => {
    const home = await tempHome()
    process.env.DSH_HOME = home
    const { code, text } = await cli(['capture', 'on'])
    expect(code).toBe(0)
    expect(await readFile(markerOf(home), 'utf8')).toBe('on\n')
    expect(text).toContain('WorkBuddy capture: on — decided by the marker file')
    expect(text).toContain('no restart needed')
  })

  it('writes off rather than deleting, so a launchd variable cannot silently win', async () => {
    const home = await tempHome()
    process.env.DSH_HOME = home
    process.env.DSH_WORKBUDDY_CAPTURE = '1'
    await cli(['capture', 'on'])
    const { text } = await cli(['capture', 'off'])
    expect(await readFile(markerOf(home), 'utf8')).toBe('off\n')
    expect(text).toContain('WorkBuddy capture: off — decided by the marker file')
    // Still off with the environment variable present: the marker outranks it.
    const status = await cli(['capture', 'status', '--json'])
    expect(status.json['capture']).toMatchObject({ enabled: false, source: 'marker' })
  })

  it('reports which input decided the switch', async () => {
    const home = await tempHome()
    process.env.DSH_HOME = home
    const absent = await cli(['capture', 'status', '--json'])
    expect(absent.json['capture']).toMatchObject({ enabled: false, source: 'default' })
    process.env.DSH_WORKBUDDY_CAPTURE = '1'
    const fromEnv = await cli(['capture', 'status', '--json'])
    expect(fromEnv.json['capture']).toMatchObject({ enabled: true, source: 'env' })
  })

  it('needs no sign-in to answer', async () => {
    const home = await tempHome()
    process.env.DSH_HOME = home
    process.env.WORKBUDDY_AUTH_FILE = join(home, 'absent-desktop.info')
    const { code, text } = await cli(['capture', 'status'])
    expect(code).toBe(0)
    expect(text).not.toContain('signed out')
  })

  it('refuses an unknown word instead of guessing', async () => {
    const home = await tempHome()
    process.env.DSH_HOME = home
    const { code, errors } = await cli(['capture', 'enable'])
    expect(code).toBe(1)
    expect(errors).toContain('expected capture on, off, or status')
    expect(await exists(markerOf(home))).toBe(false)
  })

  it('rejects two positional words', async () => {
    const home = await tempHome()
    process.env.DSH_HOME = home
    const { code, errors } = await cli(['capture', 'on', 'off'])
    expect(code).toBe(1)
    expect(errors).toContain('invalid options for capture')
  })

  it('says where the ledger will land once enabled', async () => {
    const home = await tempHome()
    process.env.DSH_HOME = home
    const { text } = await cli(['capture', 'on'])
    expect(text).toContain(join(home, WIRE_CAPTURE_DIRNAME))
    expect(text).toMatch(/workbuddy-\d{4}-\d{2}-\d{2}\.jsonl/u)
  })
})
