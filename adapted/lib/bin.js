#!/usr/bin/env node
import { E as variantFor, G as wireCaptureEnabled, H as readWireLedgerTail, K as wireCaptureFile, S as atRestKeyProviderFor, T as WORKBUDDY_VARIANTS, U as setWireCapture, W as wireCaptureDir, a as isHeartbeatProcessAlive, c as workbuddyHostHeartbeatPath, d as FALLBACK_WORKBUDDY_AI_MODELS, f as FALLBACK_WORKBUDDY_MODELS, g as WorkBuddyCredentialStore, j as WorkBuddyUpstreamClient, lt as resolveAppVersion, n as versionDriftWarning, q as wireCaptureState, s as readHostHeartbeat, t as versionDrift, u as WORKBUDDY_CONNECT_VERSION, w as CN_VARIANT } from "./version-resolve-Ciac7LIC.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region src/bin.ts
/** Standalone status/diagnostics CLI for the dsh-workbuddy-connect bundle. */
const JSON_SCHEMA_VERSION = 1;
/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]");
}
function printHelp() {
	process.stdout.write([
		"Usage: dsh-workbuddy-connect <doctor|status|logout|capture> [--provider <id>] [--json]",
		"",
		"  doctor   secret-free sign-in and environment diagnostics",
		"  status   sign-in state, remaining WorkBuddy credit, and host-bundle health",
		"  logout   remove the plugin-owned credential copy (the desktop app keeps its sign-in)",
		"  capture  on|off|status — switch the outbound request capture without restarting the host",
		"",
		"  --provider  which product to inspect; defaults to workbuddy",
		`              one of: ${WORKBUDDY_VARIANTS.map((variant) => variant.id).join(", ")}`,
		"  --json      emit one secret-free JSON document (doctor/status only)",
		""
	].join("\n"));
}
function printJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
/**
* One variant's store plus the client that performs its refreshes.
*
* The key provider is built by the same shared helper the plugin host uses,
* so the CLI's `doctor`/`status` and the browser card can never disagree
* about which product's Electron a variant resolves.
*/
function makeStore(variant) {
	const client = new WorkBuddyUpstreamClient();
	return new WorkBuddyCredentialStore({
		variant,
		refresh: (credential) => client.refreshToken(credential),
		keyProvider: atRestKeyProviderFor(variant)
	});
}
/** The plugin-owned credential copy for one variant, for display. */
function ownAuthPath(variant) {
	return makeStore(variant).ownAuthPath();
}
/** Fallback roster size for one variant. */
function fallbackCount(variant) {
	return variant.id === CN_VARIANT.id ? FALLBACK_WORKBUDDY_MODELS.length : FALLBACK_WORKBUDDY_AI_MODELS.length;
}
async function doctor(jsonOutput, variant) {
	const store = makeStore(variant);
	const status = await store.status();
	const desktopPresent = await store.desktopFilePresent();
	const desktopFormat = await store.desktopAuthFormat();
	const desktopPath = await store.resolvedDesktopAuthPath() ?? store.desktopAuthPath();
	const heartbeat = await readHostHeartbeat();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	const appVersion = variant.region === "global" ? await resolveAppVersion() : void 0;
	const decryptionNote = status.state === "signed-out" && desktopFormat === "encrypted" && status.reason !== void 0 ? `Encrypted desktop credential could not be used: ${status.reason}` : void 0;
	const drift = versionDrift();
	const driftWarning = versionDriftWarning(drift);
	const report = {
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-workbuddy-connect",
		version: WORKBUDDY_CONNECT_VERSION,
		node: process.version,
		provider: variant.id,
		displayName: variant.displayName,
		desktopAuthFile: {
			path: desktopPath ?? `(no platform default; set ${variant.env})`,
			present: desktopPresent,
			format: desktopFormat
		},
		ownAuthFile: ownAuthPath(variant),
		...appVersion === void 0 ? {} : { catalogUserAgent: {
			version: appVersion.version,
			source: appVersion.source,
			...appVersion.bundle === void 0 ? {} : { bundle: appVersion.bundle }
		} },
		hostHeartbeat: {
			path: workbuddyHostHeartbeatPath(),
			present: heartbeat !== void 0,
			...heartbeat === void 0 ? {} : {
				registeredAt: heartbeat.registeredAt,
				pid: heartbeat.pid
			},
			processAlive: hostAlive
		},
		signIn: status.state,
		fallbackModels: fallbackCount(variant),
		...drift === void 0 ? {} : { manifestVersion: drift.manifest },
		hints: [
			...decryptionNote !== void 0 ? [decryptionNote] : status.state === "signed-out" ? [`Sign in once in the ${variant.appName} desktop app, then run status again.`] : [],
			...desktopPresent ? [] : [`No ${variant.appName} desktop auth file at the expected path; set ${variant.env} if it lives elsewhere.`],
			...hostAlive ? [] : ["Host bundle not running in this DSH profile (or the process exited). The browser card and provider are unavailable until DSH starts the plugin."],
			...driftWarning === void 0 ? [] : [driftWarning]
		]
	};
	if (jsonOutput) printJson({
		...report,
		...decryptionNote === void 0 ? {} : { decryptionNote }
	});
	else process.stdout.write([
		`${variant.displayName} Connect ${WORKBUDDY_CONNECT_VERSION} on ${process.version}`,
		`Desktop auth file: ${report.desktopAuthFile.present ? "present" : "missing"} — ${desktopFormat} (${report.desktopAuthFile.path})`,
		`Host bundle: ${hostAlive ? `running (pid ${heartbeat.pid})` : heartbeat !== void 0 ? "stale heartbeat (process exited)" : "not started"}`,
		`Sign-in state: ${report.signIn}`,
		`Static fallback models: ${report.fallbackModels}`,
		...drift === void 0 ? [] : [`Manifest version: ${drift.manifest} (loaded build is ${drift.build})`],
		...appVersion === void 0 ? [] : [`Catalog User-Agent version: ${appVersion.version} (${appVersion.source})`],
		...report.hints.map((hint) => `Hint: ${hint}`),
		""
	].join("\n"));
	return status.state === "signed-in" && desktopPresent ? 0 : 1;
}
function compatSummary(tail, captureEnabled) {
	const captured = tail?.record.request;
	const system = captured?.compat?.lastSystem;
	return {
		captureEnabled,
		...captureEnabled ? { captureDir: wireCaptureDir() } : {},
		...tail === void 0 ? {} : { file: tail.file },
		...tail === void 0 ? {} : { lastRequestAt: tail.record.at },
		...captured?.compat === void 0 ? {} : { enabled: captured.compat.enabled },
		...captured?.compat === void 0 ? {} : { ruleVersion: captured.compat.ruleVersion },
		...tail?.record.result?.status === void 0 ? {} : { lastStatus: tail.record.result.status },
		...tail?.record.result?.kind === void 0 ? {} : { lastOutcome: tail.record.result.kind },
		...captured?.body?.model === void 0 ? {} : { model: captured.body.model },
		...system === void 0 ? {} : {
			systemCharsBefore: system.charsBefore,
			systemCharsAfter: system.charsAfter,
			opener: system.opener,
			gui: system.gui,
			lastParagraphHead: system.lastParagraphHead
		}
	};
}
/** Human lines for {@link compatSummary}; empty when nothing was ever captured. */
function compatLines(summary) {
	const capture = summary.captureEnabled ? `Capture: on → ${summary.captureDir ?? "unknown directory"}` : "Capture: off (run `capture on`, or start the host with DSH_WORKBUDDY_CAPTURE=1, to record a request)";
	if (summary.lastRequestAt === void 0) return ["Channel compat: no captured request yet — the plugin card reports the live switch", capture];
	const verdict = summary.lastStatus === void 0 ? "no answer recorded" : `${summary.lastStatus}${summary.lastOutcome === void 0 ? "" : ` ${summary.lastOutcome}`}`;
	const lines = [`Channel compat: prompt rewrite ${summary.enabled === true ? "on" : summary.enabled === false ? "off" : "unknown"}${summary.ruleVersion === void 0 ? "" : ` (${summary.ruleVersion})`}${summary.model === void 0 ? "" : ` · model ${summary.model}`} · last request ${summary.lastRequestAt} → ${verdict}`];
	if (summary.systemCharsBefore !== void 0 && summary.systemCharsAfter !== void 0) lines.push(`  system prompt: ${summary.systemCharsBefore} → ${summary.systemCharsAfter} chars${summary.opener === void 0 ? "" : ` · opener ${summary.opener}`}${summary.gui === void 0 ? "" : ` · gui ${summary.gui}`}`);
	if (summary.lastParagraphHead !== void 0) lines.push(`  last paragraph starts: ${JSON.stringify(summary.lastParagraphHead)}`);
	lines.push(capture);
	return lines;
}
/**
* `capture on|off|status`: the live switch for the outbound request ledger.
*
* The environment variable can only be set before the host starts, so this is
* the command that makes capture controllable while it runs: it writes the
* marker file the plugin reads on every request. `status` reports which input
* decided the switch, because "off" and "never configured" read differently to
* someone debugging a refusal.
*/
async function capture(state, jsonOutput) {
	const wanted = state === void 0 ? "status" : state.toLowerCase();
	if (wanted === "on" || wanted === "off") setWireCapture(wanted === "on");
	else if (wanted !== "status") {
		process.stderr.write(`dsh-workbuddy-connect: expected capture on, off, or status; got ${JSON.stringify(state)}\n`);
		return 1;
	}
	const current = wireCaptureState();
	const ledger = wireCaptureFile(/* @__PURE__ */ new Date(), current.dir);
	const label = current.enabled ? "on" : "off";
	const headline = current.source === "marker" ? `WorkBuddy capture: ${label} — decided by the marker file` : current.source === "env" ? `WorkBuddy capture: ${label} — decided by DSH_WORKBUDDY_CAPTURE, set when the host started` : "WorkBuddy capture: off — no marker file and no DSH_WORKBUDDY_CAPTURE";
	if (jsonOutput) {
		printJson({
			schemaVersion: JSON_SCHEMA_VERSION,
			package: "dsh-workbuddy-connect",
			version: WORKBUDDY_CONNECT_VERSION,
			capture: {
				enabled: current.enabled,
				source: current.source,
				marker: current.marker,
				dir: current.dir,
				ledger
			}
		});
		return 0;
	}
	process.stdout.write([
		headline,
		`  marker: ${current.marker}${current.source === "marker" ? "" : " (absent)"}`,
		`  ledger: ${ledger}`,
		current.enabled ? "  The next upstream request is recorded; no restart needed." : `  Nothing is recorded. Turn it on with \`capture on\` (or create the marker file); no restart needed.`,
		""
	].join("\n"));
	return 0;
}
async function status(jsonOutput, variant) {
	const store = makeStore(variant);
	const client = new WorkBuddyUpstreamClient();
	const authStatus = await store.status();
	const captureEnabled = wireCaptureEnabled();
	const compat = compatSummary(await readWireLedgerTail(variant.id).catch(() => void 0), captureEnabled);
	const heartbeat = await readHostHeartbeat();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	const hostState = hostAlive ? "running" : heartbeat !== void 0 ? "stale" : "not-started";
	if (authStatus.state !== "signed-in") {
		if (jsonOutput) printJson({
			schemaVersion: JSON_SCHEMA_VERSION,
			package: "dsh-workbuddy-connect",
			version: WORKBUDDY_CONNECT_VERSION,
			provider: variant.id,
			status: "signed-out",
			hostBundle: hostState,
			channelCompat: compat
		});
		else process.stdout.write([
			`${variant.displayName} Connect: signed out`,
			`Host bundle: ${hostState}`,
			...compatLines(compat),
			""
		].join("\n"));
		return 1;
	}
	let credits;
	try {
		const credential = await store.current();
		if (credential !== void 0) {
			const fetched = await client.fetchCredits(credential);
			credits = {
				total: fetched.total,
				...fetched.unlimited === true ? { unlimited: true } : {}
			};
		}
	} catch (error) {
		credits = {
			total: 0,
			error: safeMessage(error)
		};
	}
	const expiresAt = authStatus.expiresAtMs !== void 0 ? new Date(authStatus.expiresAtMs).toISOString() : void 0;
	if (jsonOutput) {
		printJson({
			schemaVersion: JSON_SCHEMA_VERSION,
			package: "dsh-workbuddy-connect",
			version: WORKBUDDY_CONNECT_VERSION,
			provider: variant.id,
			status: "signed-in",
			...expiresAt === void 0 ? {} : { accessTokenExpires: expiresAt },
			...authStatus.nickname === void 0 ? {} : { nickname: authStatus.nickname },
			...authStatus.domain === void 0 || authStatus.domain === "" ? {} : { domain: authStatus.domain },
			source: authStatus.source,
			credits: credits?.total,
			...credits?.unlimited === true ? { creditsUnlimited: true } : {},
			...credits?.error === void 0 ? {} : { creditsError: credits.error },
			hostBundle: hostState,
			channelCompat: compat
		});
		return 0;
	}
	process.stdout.write([
		`${variant.displayName} Connect: signed in${authStatus.nickname === void 0 ? "" : ` as ${authStatus.nickname}`}`,
		...expiresAt === void 0 ? [] : [`Access token expires ${expiresAt} (refresh is automatic)`],
		credits?.error !== void 0 ? `Remaining credit: unavailable (${credits.error})` : credits?.unlimited === true ? "Remaining credit: unlimited" : `Remaining credit: ${credits?.total ?? "unknown"}`,
		`Host bundle: ${hostAlive ? `running (pid ${heartbeat.pid})` : hostState === "stale" ? "stale heartbeat (DSH process exited)" : "not started in this profile"}`,
		...compatLines(compat),
		"Client card: load failures are logged to the browser console only; the host provider is unaffected.",
		""
	].join("\n"));
	return 0;
}
/** Execute one boot-free command. */
async function run(argv) {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		printHelp();
		return 0;
	}
	const [rawAction, ...flags] = argv;
	if (![
		"capture",
		"doctor",
		"logout",
		"status"
	].includes(rawAction)) {
		process.stderr.write(`dsh-workbuddy-connect: expected capture, doctor, logout, or status; got ${JSON.stringify(rawAction)}\n`);
		return 1;
	}
	const action = rawAction;
	const jsonOutput = flags.includes("--json");
	if (action === "capture") {
		const words = flags.filter((flag) => flag !== "--json");
		if (words.length > 1) {
			process.stderr.write(`dsh-workbuddy-connect: invalid options for capture: ${flags.join(" ")}\n`);
			return 1;
		}
		try {
			return await capture(words[0], jsonOutput);
		} catch (error) {
			process.stderr.write(`dsh-workbuddy-connect: capture failed: ${safeMessage(error)}\n`);
			return 1;
		}
	}
	let providerId;
	const rest = [];
	for (let index = 0; index < flags.length; index += 1) {
		const flag = flags[index];
		if (flag === "--provider") {
			providerId = flags[index + 1];
			index += 1;
			continue;
		}
		if (flag.startsWith("--provider=")) {
			providerId = flag.slice(11);
			continue;
		}
		rest.push(flag);
	}
	const variant = providerId === void 0 ? CN_VARIANT : variantFor(providerId);
	if (variant === void 0) {
		process.stderr.write(`dsh-workbuddy-connect: unknown provider ${JSON.stringify(providerId)}; expected one of ${WORKBUDDY_VARIANTS.map((v) => v.id).join(", ")}\n`);
		return 1;
	}
	if (rest.filter((flag) => flag !== "--json").length > 0 || jsonOutput && action === "logout") {
		process.stderr.write(`dsh-workbuddy-connect: invalid options for ${action}: ${flags.join(" ")}\n`);
		return 1;
	}
	try {
		switch (action) {
			case "doctor": return await doctor(jsonOutput, variant);
			case "status": return await status(jsonOutput, variant);
			case "logout": {
				const store = makeStore(variant);
				await store.logout();
				process.stdout.write(`${variant.displayName} Connect: removed ${store.ownAuthPath()}; the desktop app's sign-in is untouched\n`);
				return 0;
			}
		}
	} catch (error) {
		process.stderr.write(`dsh-workbuddy-connect: ${action} failed: ${safeMessage(error)}\n`);
		return 1;
	}
}
if (process.argv[1] !== void 0 && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = await run(process.argv.slice(2));
//#endregion
export { run };
