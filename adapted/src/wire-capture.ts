/**
 * Opt-in outbound wire capture for the WorkBuddy route.
 *
 * Why this exists: every measured channel refusal so far was only expressible
 * as "the same request body, replayed later, answered 200" — and the numbers
 * that would separate a patch that did not run from an upstream rule that
 * changed were printed by a diagnostic script rather than by the plugin. This
 * module makes those numbers a first-class artifact of the running host:
 *
 * ```
 * DSH_WORKBUDDY_CAPTURE=1          # at host start, or
 * workbuddy capture on             # any time, no restart
 * ```
 *
 * The environment variable is read per request but can only be set before the
 * host starts (macOS does not hand a launched app the shell's exports), so a
 * marker file is the live switch:
 *
 * - `$DSH_HOME/workbuddy-wire/.capture-enabled` present → on;
 * - the same file saying `off`, `0`, `false`, or `no` → off, even when the
 *   environment variable says on (a launchd-set variable is otherwise
 *   impossible to defeat without a restart);
 * - file absent → the environment variable decides.
 *
 * `workbuddy capture on|off|status` writes and reports that file, and
 * {@link wireCaptureState} names which of the two decided, so the card can say
 * "off" without implying "never configured".
 *
 * One JSON line per outbound chat request, appended under
 * `$DSH_HOME/workbuddy-wire/workbuddy-YYYY-MM-DD.jsonl`. What goes in:
 *
 * - endpoint, method, region, variant, model, and the message/tool counts;
 * - `Authorization` reduced to its length and last four characters — never the
 *   token, never a prefix;
 * - the body's byte length and SHA-256, so two requests can be compared for
 *   byte equality without storing either body;
 * - the channel-compat decision ({@link ChannelCompatDigest}: rule version,
 *   permit value, per-rule outcome, character delta, marker counts);
 * - the chat identity the request claimed (`clientVersion`, `cliVersion`);
 * - the upstream answer: status, `extError.code`, and the first 512 bytes of a
 *   failure body (the refusal envelope is structural, not secret).
 *
 * Deliberate limits: no message content, no token material, no response body
 * on success. The capture is off by default, writes nothing when it cannot, and
 * never turns a capture failure into a request failure.
 *
 * @module dsh-workbuddy-connect/wire-capture
 */

import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ChannelCompatDigest } from './channel-compat.ts'

/** Environment switch that turns the capture on. */
export const WIRE_CAPTURE_ENV = 'DSH_WORKBUDDY_CAPTURE'

/** Directory (under `$DSH_HOME`) the JSONL ledgers are written to. */
export const WIRE_CAPTURE_DIRNAME = 'workbuddy-wire'

/**
 * Marker file inside {@link WIRE_CAPTURE_DIRNAME} that switches the capture.
 *
 * Presence is the switch, not the content: `touch` turns it on, and deleting it
 * hands control back to {@link WIRE_CAPTURE_ENV}.
 */
export const WIRE_CAPTURE_MARKER = '.capture-enabled'

/** Schema version of one record; bumped only on an incompatible change. */
export const WIRE_CAPTURE_SCHEMA_VERSION = 1

/** Everything the capture needs to know about one request, minus secrets. */
export interface WireCaptureRequest {
  provider: string
  region: 'cn' | 'global'
  url: string
  method: 'POST'
  /** Redacted header map; see {@link redactHeaders}. */
  headers: Record<string, string>
  bodyBytes: number
  bodySha256: string
  /** Parsed fields worth diffing; never content. */
  body?: {
    model?: string
    maxTokens?: number
    messageCount?: number
    roles?: readonly string[]
    toolCount?: number
    stream?: boolean
  }
  identity?: { clientVersion?: string; cliVersion?: string; userAgent?: string }
  compat?: ChannelCompatDigest
  /** 0 for the first attempt, then 1.. for channel-rejection retries. */
  attempt?: number
}

/** The upstream answer to that request. */
export interface WireCaptureResult {
  status: number
  /** `extError.code` when the failure body carried one. */
  code?: string | number
  kind?: string
  streamed?: boolean
  /** First bytes of a failure body only. */
  bodyHead?: string
  durationMs?: number
}

/** One ledger line. */
export interface WireCaptureRecord {
  schemaVersion: typeof WIRE_CAPTURE_SCHEMA_VERSION
  at: string
  /** Variant that produced the request, e.g. `workbuddy` or `workbuddy-ai`. */
  provider: string
  kind: 'chat' | 'retry'
  request?: WireCaptureRequest
  result?: WireCaptureResult
  /** Populated on `retry` lines: what the retry loop decided. */
  retry?: { attempt: number; delayMs: number; kind: string }
}

/** Values in the marker file that mean "off" rather than "on". */
const MARKER_OFF_VALUES = new Set(['off', '0', 'false', 'no', 'disabled'])

/** Absolute directory the ledgers live in. */
export function wireCaptureDir(): string {
  return join(resolveDshHome(), WIRE_CAPTURE_DIRNAME)
}

/** Absolute path of the marker file that switches the capture. */
export function wireCaptureMarkerPath(dir: string = wireCaptureDir()): string {
  return join(dir, WIRE_CAPTURE_MARKER)
}

/**
 * What the marker file says: on, off, or `undefined` when there is no file.
 *
 * Synchronous on purpose: the switch is consulted once per request and once per
 * status render, both of which already run inside a sync section, and the read
 * is a single small file. A missing file is a normal state, never an error.
 */
export function readWireCaptureMarker(dir: string = wireCaptureDir()): boolean | undefined {
  const path = wireCaptureMarkerPath(dir)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const value = raw.trim().toLowerCase()
  if (value === '') return true
  return !MARKER_OFF_VALUES.has(value)
}

/** Which input decided the capture switch. */
export type WireCaptureSource = 'marker' | 'env' | 'default'

/** The switch and how it was decided. */
export interface WireCaptureState {
  enabled: boolean
  source: WireCaptureSource
  /** Absolute marker path, so a user can find the file the report names. */
  marker: string
  dir: string
}

function envEnabled(env: NodeJS.ProcessEnv): boolean | undefined {
  const raw = env[WIRE_CAPTURE_ENV]
  if (raw === undefined) return undefined
  const value = raw.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

/**
 * The capture switch, with the input that decided it.
 *
 * Precedence is marker → environment → off. The marker wins so that a host
 * started with `DSH_WORKBUDDY_CAPTURE=1` (or a `launchctl setenv`) can be
 * silenced again without quitting the app.
 */
export function wireCaptureState(env: NodeJS.ProcessEnv = process.env, dir: string = wireCaptureDir()): WireCaptureState {
  const marker = readWireCaptureMarker(dir)
  if (marker !== undefined) return { enabled: marker, source: 'marker', marker: wireCaptureMarkerPath(dir), dir }
  const fromEnv = envEnabled(env)
  if (fromEnv !== undefined) return { enabled: fromEnv, source: 'env', marker: wireCaptureMarkerPath(dir), dir }
  return { enabled: false, source: 'default', marker: wireCaptureMarkerPath(dir), dir }
}

/**
 * Whether the capture is on.
 *
 * Read per request rather than at construction: the marker file changes without
 * a restart, and the read is one small file.
 */
export function wireCaptureEnabled(env: NodeJS.ProcessEnv = process.env, dir?: string): boolean {
  return wireCaptureState(env, dir).enabled
}

/**
 * Turn the capture on or off by writing the marker file.
 *
 * Returns the state as re-read from disk, so a caller can print what actually
 * happened rather than what it intended. A failure to create the directory is
 * reported as a thrown error: this is the one capture path a user asked for
 * explicitly, and silently doing nothing would be worse than failing.
 */
export function setWireCapture(enabled: boolean, dir: string = wireCaptureDir()): WireCaptureState {
  mkdirSync(dir, { recursive: true })
  writeFileSync(wireCaptureMarkerPath(dir), enabled ? 'on\n' : 'off\n', 'utf8')
  return wireCaptureState(process.env, dir)
}

/** Delete the marker file, handing the switch back to the environment. */
export function clearWireCaptureMarker(dir: string = wireCaptureDir()): void {
  rmSync(wireCaptureMarkerPath(dir), { force: true })
}


/** Absolute path of one day's ledger. */
export function wireCaptureFile(date: Date, dir: string = wireCaptureDir()): string {
  const day = date.toISOString().slice(0, 10)
  return join(dir, `workbuddy-${day}.jsonl`)
}

/** Last four characters of a bearer, with its length — never the token. */
export function redactAuthorization(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length === 0) return 'absent'
  const tail = value.length <= 4 ? '' : value.slice(-4)
  return `len=${value.length} tail=${tail === '' ? 'n/a' : tail}`
}

/**
 * Copy a header map, reducing the one credential-bearing entry to its shape.
 *
 * Header names are lowercased so two captures from different call sites diff
 * cleanly. Values are length-capped: a hostile or accidental header must not be
 * able to grow the ledger without bound.
 */
export function redactHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const name = key.toLowerCase()
    out[name] = name === 'authorization' ? redactAuthorization(value) : value.slice(0, 200)
  }
  return out
}

/** In-memory view of the most recent decision, for the status card. */
export interface ChannelCompatSnapshot {
  provider: string
  ruleVersion: string
  enabled: boolean
  atMs: number
  status?: number
  kind?: string
  digest?: ChannelCompatDigest
}

const snapshots = new Map<string, ChannelCompatSnapshot>()

/** Remember one request's compat state for the status document. */
export function noteChannelCompat(snapshot: ChannelCompatSnapshot): void {
  snapshots.set(snapshot.provider, snapshot)
}

/** The last request's compat state for one variant, or undefined before the first. */
export function channelCompatSnapshot(provider: string): ChannelCompatSnapshot | undefined {
  return snapshots.get(provider)
}

/**
 * Attach this request's upstream answer to the snapshot already stored for it.
 *
 * Split from {@link noteChannelCompat} because the decision is known before the
 * request leaves and the answer only afterwards; merging keeps the card able to
 * show "rewrote 8740 → 8703, then answered 400" as one fact rather than two
 * half-filled records. A request that never recorded a decision (an
 * international one) is left alone rather than given a stray entry.
 */
export function noteChannelOutcome(provider: string, outcome: { status: number; kind: string }): void {
  const current = snapshots.get(provider)
  if (current === undefined) return
  snapshots.set(provider, { ...current, ...outcome })
}

/** Drop every in-memory record. Tests only; production state dies with the process. */
export function resetWireCapture(): void {
  snapshots.clear()
  chain = Promise.resolve()
}

// Writes are serialised through one promise chain: two concurrent chat requests
// must produce two whole JSON lines, not interleaved fragments. Failures are
// swallowed by design — a diagnostics ledger must never fail a completion.
let chain: Promise<void> = Promise.resolve()

/**
 * Append one record, fire-and-forget.
 *
 * The returned promise resolves once the line is on disk, which is what tests
 * await; production callers ignore it. Every failure (mkdir, append, a closed
 * disk) resolves quietly: this is observability, not a request dependency.
 */
export function recordWireEvent(record: WireCaptureRecord, dir?: string): Promise<void> {
  const target = wireCaptureFile(new Date(record.at), dir)
  const line = `${JSON.stringify(record)}\n`
  chain = chain
    .then(async () => {
      const parent = dir ?? wireCaptureDir()
      await mkdir(parent, { recursive: true })
      await appendFile(target, line, 'utf8')
    })
    .catch(() => undefined)
  return chain
}

/**
 * Wait until every record queued so far is on disk.
 *
 * Production never needs this — a lost diagnostic line is not worth a stall.
 * Tests do: they assert on the file immediately after the request that wrote
 * it, and an assertion that races the append would be a flake, not a finding.
 */
export function flushWireCapture(): Promise<void> {
  return chain
}

/** One captured request, as far as the CLI reports it. */
export interface WireLedgerTail {
  file: string
  record: WireCaptureRecord
}

/**
 * Read the most recent captured record for one variant.
 *
 * Scans the newest ledger file backwards a line at a time rather than loading
 * the file: a captured day can hold thousands of lines, and only the last one
 * that names this provider matters. Returns undefined when the capture never
 * ran, which is a normal state rather than an error.
 */
export async function readWireLedgerTail(provider?: string, dir: string = wireCaptureDir()): Promise<WireLedgerTail | undefined> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter(name => name.startsWith('workbuddy-') && name.endsWith('.jsonl'))
  } catch {
    return undefined
  }
  names.sort()
  for (const name of names.reverse()) {
    const file = join(dir, name)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]
      if (line === undefined || line.trim().length === 0) continue
      try {
        const record = JSON.parse(line) as WireCaptureRecord
        if (provider !== undefined && record.provider !== provider) continue
        return { file, record }
      } catch {
        // A truncated final line (crash mid-append) is skipped, not fatal.
      }
    }
  }
  return undefined
}
