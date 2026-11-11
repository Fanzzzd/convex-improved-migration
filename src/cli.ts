#!/usr/bin/env node
// The command line program. A thin wrapper: every command runs
// `convex run <module>:<function> '<json>'`, parses the JSON result, and
// turns it into readable output and an exit code.
//
// Exit codes: 0 every Step is Done (or the command succeeded), 1 a Step
// failed, a check failed or the server refused, 2 --timeout passed while the
// run keeps working in the background, 64 usage error, 130 and 143 after
// SIGINT and SIGTERM.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const BIN = "npx convex-improved-migration";

const USAGE = `Usage: ${BIN} <command> [options]

Commands:
  apply [--only <id>] [--timeout <duration>] [--no-wait]
                          Run the Plan, print progress, wait for the end.
                          --no-wait starts a background run and returns
  apply --dry-run [--only <id>]
                          Print what would run and the next Batch's writes
  rebuild --all | <id>... [--timeout <duration>] [--no-wait]
                          Mark Rebuilds pending, then behave like apply
  status [--events <id>]  Print the state of every Step
  check                   Exit 1 unless every Step is Done
  mark-done <id> --reason <text>
                          Record a Step as Done without running it
  reset <id>              Clear a Step's progress so it runs again
  cancel                  Stop the run at the next Batch boundary
  adopt --expect-count <n>
                          Copy Done records from @convex-dev/migrations

Options:
  --module <path>         File that exports the functions. Default "migrations"
  --json                  Print the raw JSON result
  --help                  Print this text
  --                      Every later argument is a Step id, also one that
                          starts with "-"
  --prod, --deployment <name>, --preview-name <name>,
  --deployment-name <name>, --env-file <path>, --url <url>, --admin-key <key>
                          Passed to "convex run" unchanged`;

const PASS_BOOL = new Set(["--prod"]);
const PASS_VALUE = new Set([
	"--deployment",
	"--preview-name",
	"--deployment-name",
	"--env-file",
	"--url",
	"--admin-key",
]);
const OWN_BOOL = new Set(["--json", "--no-wait", "--dry-run", "--all"]);
const OWN_VALUE = new Set([
	"--module",
	"--only",
	"--timeout",
	"--events",
	"--reason",
	"--expect-count",
]);
/** What each command reads, beside --module, --json and the pass-through options. */
const COMMAND_OPTIONS: Record<string, string[]> = {
	apply: ["--only", "--timeout", "--no-wait", "--dry-run"],
	rebuild: ["--all", "--timeout", "--no-wait"],
	status: ["--events"],
	check: [],
	"mark-done": ["--reason"],
	reset: [],
	cancel: [],
	adopt: ["--expect-count"],
};
/** How many positional arguments a command takes at most. */
const POSITIONAL: Record<string, number> = {
	rebuild: Infinity,
	"mark-done": 1,
	reset: 1,
};
const EXCLUSIVE: [string, string][] = [
	["--dry-run", "--no-wait"],
	["--dry-run", "--timeout"],
	["--no-wait", "--timeout"],
];

class UsageError extends Error {}
/** The user asked for the usage text: print it and exit 0. */
class HelpRequest extends Error {}

type Parsed = {
	command: string;
	positional: string[];
	flags: Map<string, string | true>;
	pass: string[];
};

function parse(argv: string[]): Parsed {
	const [command, ...rest] = argv;
	const isHelp = (a: string) => a === "--help" || a === "-h";
	if (!command || command === "help" || isHelp(command)) {
		throw new HelpRequest();
	}
	const allowed = COMMAND_OPTIONS[command];
	if (!allowed) {
		if (rest.some(isHelp)) throw new HelpRequest();
		throw new UsageError(`Unknown command "${command}".`);
	}
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	const pass: string[] = [];
	const given = new Set<string>();
	// Every token is either used exactly as typed or refused with a usage
	// error. Nothing is dropped.
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === undefined) break;
		if (arg === "--") {
			positional.push(...rest.slice(i + 1));
			break;
		}
		const [name, inline] =
			arg.startsWith("--") && arg.includes("=")
				? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
				: [arg, undefined];
		if (isHelp(name)) {
			if (inline !== undefined) throw new UsageError(`${name} takes no value.`);
			throw new HelpRequest();
		}
		const value = () => {
			if (inline !== undefined) return inline;
			const next = rest[++i];
			if (next === undefined) throw new UsageError(`${name} needs a value.`);
			// `--reason --prod` is a forgotten value, not a reason.
			if (next.startsWith("--")) {
				throw new UsageError(
					`${name} needs a value, and "${next}" is an option. To use it as the value, write ${name}=${next}.`,
				);
			}
			return next;
		};
		const filled = () => {
			const v = value();
			if (!v.trim()) throw new UsageError(`${name} needs a value.`);
			return v;
		};
		const known =
			PASS_BOOL.has(name) ||
			PASS_VALUE.has(name) ||
			OWN_BOOL.has(name) ||
			OWN_VALUE.has(name);
		// The second value of a repeated option would win without a word.
		if (known && given.has(name)) {
			throw new UsageError(`${name} is given twice.`);
		}
		given.add(name);
		// `--prod=false` must not target production.
		if ((PASS_BOOL.has(name) || OWN_BOOL.has(name)) && inline !== undefined) {
			throw new UsageError(`${name} takes no value.`);
		}
		if (PASS_BOOL.has(name)) pass.push(name);
		else if (PASS_VALUE.has(name)) pass.push(name, filled());
		else if (OWN_BOOL.has(name)) flags.set(name, true);
		else if (OWN_VALUE.has(name)) flags.set(name, filled());
		else if (name.startsWith("-"))
			throw new UsageError(
				`Unknown option ${name}.` +
					(POSITIONAL[command]
						? ` A Step id that starts with "-" goes after --.`
						: ""),
			);
		else positional.push(arg);
	}
	// An option the command does not read would change what the user asked
	// for without a word: `rebuild --all --dry-run` must not rebuild.
	for (const name of flags.keys()) {
		if (name !== "--module" && name !== "--json" && !allowed.includes(name)) {
			throw new UsageError(`${name} is not an option of ${command}.`);
		}
	}
	if (positional.length > (POSITIONAL[command] ?? 0)) {
		throw new UsageError(
			`${command} does not take "${positional[POSITIONAL[command] ?? 0]}".`,
		);
	}
	for (const [a, b] of EXCLUSIVE) {
		if (flags.has(a) && flags.has(b)) {
			throw new UsageError(`${a} and ${b} cannot be used together.`);
		}
	}
	return { command, positional, flags, pass };
}

/** The function threw on the server. */
class ServerError extends Error {}
/**
 * `convex run` failed without an error from the function: no connection, a
 * call dropped by the client's 300 s limit, or a refusal before the function
 * ran. Whether the function ran is unknown.
 */
class TransportError extends Error {}

/** Running `convex run` children, stopped when the CLI exits early. */
const children = new Set<ChildProcess>();

let convexScript: string | null | undefined;
/**
 * How to start the Convex CLI. Its own script runs with this Node when the
 * project has convex installed, with no shell in between. Without it, `npx`
 * runs on macOS and Linux, also without a shell. On Windows `npx` is a .cmd
 * file that needs a shell, and cmd.exe would read quotes and `&` in a Step id
 * or a reason as shell syntax, so the CLI refuses there instead.
 */
function convexCommand(): { command: string; first: string[] } {
	if (convexScript === undefined) {
		try {
			const require = createRequire(join(process.cwd(), "package.json"));
			const manifest = require.resolve("convex/package.json");
			const bin = JSON.parse(readFileSync(manifest, "utf8")).bin;
			const script = typeof bin === "string" ? bin : bin?.convex;
			convexScript = script ? join(dirname(manifest), script) : null;
		} catch {
			convexScript = null;
		}
	}
	if (convexScript) return { command: process.execPath, first: [convexScript] };
	if (process.platform === "win32") {
		throw new Error(
			"Could not find the convex package in this project. Install it with npm install convex, then run this command from the project folder.",
		);
	}
	return { command: "npx", first: ["convex"] };
}

const TARGET_FLAGS = [
	"--prod",
	"--deployment",
	"--preview-name",
	"--deployment-name",
	"--url",
	"--admin-key",
];

/**
 * A note for a local deployment. Without `convex dev`, `convex run` starts
 * the local backend itself, and the run moves only while that process lives.
 */
function localNote(p: Parsed, started = false): string {
	if (!isLocal(p)) return "";
	if (started) {
		return (
			"\nOn a local deployment without npx convex dev running, the backend stops when this command exits. " +
			"The run moves only while npx convex dev or a later command keeps the backend up."
		);
	}
	return (
		"\nOn a local deployment without npx convex dev running, the backend is a process that convex run started. " +
		"The run moves only while that process lives. If it still runs, stop it before you start npx convex dev on the same port."
	);
}

function isLocal(p: Parsed): boolean {
	if (p.pass.some((a) => TARGET_FLAGS.includes(a))) return false;
	let target = process.env.CONVEX_DEPLOYMENT;
	if (!target) {
		const at = p.pass.indexOf("--env-file");
		const file = (at >= 0 ? p.pass[at + 1] : undefined) ?? ".env.local";
		try {
			const text = readFileSync(join(process.cwd(), file), "utf8");
			target = /^CONVEX_DEPLOYMENT=["']?(\S*)/m.exec(text)?.[1];
		} catch {
			return false;
		}
	}
	return /^(anonymous|local):/.test(target ?? "");
}

function moduleOf(p: Parsed): string {
	return (p.flags.get("--module") as string | undefined) ?? "migrations";
}

/** A command of this program for a message, with the module the user chose. */
function own(p: Parsed, command: string): string {
	const module = moduleOf(p);
	const target = targetFlags(p);
	return `${BIN} ${command}${module === "migrations" ? "" : ` --module ${module}`}${target ? ` ${target}` : ""}`;
}

/** The deployment flags as the user typed them, with the admin key hidden. */
function targetFlags(p: Parsed): string {
	const out: string[] = [];
	for (const [i, a] of p.pass.entries()) {
		const value = PASS_VALUE.has(p.pass[i - 1] ?? "");
		if (value && p.pass[i - 1] === "--admin-key") out.push("<key>");
		else out.push(value && /[\s'"]/.test(a) ? JSON.stringify(a) : a);
	}
	return out.join(" ");
}

/** The command line being run, for the commands in server messages. */
let current: Parsed | undefined;

/**
 * The server names next commands without the deployment flags, which it
 * cannot see. Say to add them, so a hint after `apply --prod` does not
 * target the dev deployment.
 */
function withTarget(text: string): string {
	const target = current ? targetFlags(current) : "";
	if (!target || text.includes(target)) return text;
	if (!text.includes(`${BIN} `) && !text.includes("npx convex run "))
		return text;
	return `${text}\nAdd ${target} to each command above.`;
}

/** Run one function with `convex run` and parse its JSON result. */
function convexRun(p: Parsed, fn: string, args: object): Promise<any> {
	const module = moduleOf(p);
	let start: { command: string; first: string[] };
	try {
		start = convexCommand();
	} catch (e) {
		return Promise.reject(e);
	}
	const { command, first } = start;
	const argv = [
		...first,
		"run",
		...p.pass,
		`${module}:${fn}`,
		JSON.stringify(args),
	];
	return new Promise((resolve, reject) => {
		const child = spawn(command, argv, {
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (err += c));
		children.add(child);
		child.on("error", (e) => {
			children.delete(child);
			reject(new TransportError(`Could not start convex run: ${e.message}`));
		});
		child.on("close", (code) => {
			children.delete(child);
			if (code !== 0) {
				const raw = err || out;
				// A wrong --module, or functions that were never pushed. Final:
				// trying again does not help.
				const missing = /^Could not find function for .*$/m.exec(raw);
				if (missing) {
					return reject(
						new ServerError(
							fn === "adopt"
								? `${missing[0]}\nAdd \`export const adopt = m.adopt(components.<name>)\` beside the Plan, where <name> mounts @convex-dev/migrations. If the Plan is in another file, pass --module <file>.`
								: `${missing[0]}\nIf the Plan is in another file, pass --module <file>: the path under convex/ without .ts, for example --module ops/plan.`,
						),
					);
				}
				return reject(
					/Uncaught /.test(raw)
						? new ServerError(serverMessage(raw))
						: new TransportError(raw.trim() || `convex run exited ${code}.`),
				);
			}
			try {
				resolve(lastJson(out));
			} catch {
				// The function ran, but its result is unknown.
				reject(
					new TransportError(
						`Could not read the result of ${module}:${fn}:\n${out}`,
					),
				);
			}
		});
	});
}

/**
 * A read whose answer the CLI acts on. Tried up to 3 times, 2 s apart, when
 * `convex run` gets no answer. An error thrown by the function is final.
 */
async function read(p: Parsed, fn: string, args: object): Promise<any> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await convexRun(p, fn, args);
		} catch (e) {
			if (!(e instanceof TransportError) || attempt >= 3) throw e;
			await new Promise((r) => setTimeout(r, 2000));
		}
	}
}

/**
 * An operator command: mark-done, reset, cancel or adopt. The server already
 * retries its writes; when a busy driver still wins every time, try the whole
 * command again, up to 3 times, 1 s apart.
 */
async function write(p: Parsed, fn: string, args: object): Promise<any> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await convexRun(p, fn, args);
		} catch (e) {
			const conflict =
				/OptimisticConcurrencyControlFailure|changed while this mutation was being run/i.test(
					(e as Error).message,
				);
			if (!conflict || attempt >= 3) throw e;
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
}

/** `convex run` prints the result as JSON. Take the last top-level value. */
function lastJson(out: string): unknown {
	const text = out.trim();
	try {
		return JSON.parse(text);
	} catch {
		const lines = text.split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			if (/^[[{"0-9tfn-]/.test(lines[i] ?? "")) {
				try {
					return JSON.parse(lines.slice(i).join("\n"));
				} catch {
					// keep looking
				}
			}
		}
		throw new Error("no JSON");
	}
}

/** Keep the thrown message; drop the CLI banner, request id and stack. */
function serverMessage(raw: string): string {
	const lines = raw.split("\n");
	const start = lines.findIndex((l) => /Uncaught (Convex)?Error:/.test(l));
	const body = (start >= 0 ? lines.slice(start) : lines)
		.filter((l) => !/^\s+at /.test(l))
		.map((l) => l.replace(/^Uncaught (Convex)?Error: /, ""));
	return body.join("\n").trim();
}

function parseDuration(text: string): number {
	const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
	if (!m)
		throw new UsageError(`Cannot read duration "${text}". Use 90s, 30m or 2h.`);
	const n = Number(m[1]);
	const unit = m[2] ?? "s";
	return n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]!;
}

function needOne(p: Parsed, what: string): string {
	if (p.positional.length !== 1)
		throw new UsageError(`${p.command} needs exactly one ${what}.`);
	return p.positional[0] ?? "";
}

type StepStatus = {
	id: string;
	kind: string;
	table?: boolean;
	state: string;
	processed: number;
	skipped: number;
	reason: string | null;
	runId: string | null;
	error: {
		message: string;
		batch: number;
		batchSize: number;
		processed: number;
		phase?: string;
	} | null;
	wouldRun?: boolean;
	changes?: { table: string; op: string; id: string | null }[];
};
type Status = {
	state: string;
	run: { id: string; mode: string; startedAt: string; live: boolean } | null;
	steps: StepStatus[];
	orphans: { id: string; state: string; via: string | null }[];
	importSuspected?: boolean;
	next: string[];
	events?: {
		type: string;
		at: string;
		runId: string | null;
		detail: string | null;
	}[];
};

function stepLine(s: StepStatus): string {
	const counts: string[] = [];
	// A Seed or a once Step has no document counts.
	const table = s.table ?? s.kind !== "seed";
	const ran = table && s.state !== "pending";
	if (ran || s.processed > 0) counts.push(`${s.processed} processed`);
	if (s.skipped > 0) counts.push(`${s.skipped} skipped`);
	const notes = [s.reason, s.state === "failed" ? s.error?.message : null]
		.filter((n) => n)
		.join("; ");
	return `  ${s.id.padEnd(36)} ${s.state.padEnd(8)} ${counts.join(", ").padEnd(28)} ${notes}`.trimEnd();
}

function printStatus(s: Status) {
	const run = s.run
		? ` (run ${s.run.id}, ${s.run.mode}${s.run.live ? "" : ", no live driver"})`
		: "";
	console.log(`Plan: ${s.state}${run}`);
	for (const step of s.steps) console.log(stepLine(step));
	if (s.importSuspected) {
		console.log(
			"Snapshot import suspected. The next apply runs every Rebuild again.",
		);
	}
	if (s.orphans.length) {
		console.log("Removed from the Plan:");
		for (const o of s.orphans)
			console.log(
				`  ${o.id.padEnd(36)} ${o.state}${o.via ? ` via ${o.via}` : ""}`,
			);
	}
	if (s.events) {
		console.log("Events, newest first:");
		for (const e of s.events)
			console.log(`  ${e.at}  ${e.type}${e.detail ? `: ${e.detail}` : ""}`);
	}
	if (s.next.length) {
		console.log(withTarget(`Next:\n${s.next.map((n) => `  ${n}`).join("\n")}`));
	}
}

/** Set while the CLI waits for a run, for the message after Ctrl-C. */
let waitingFor: Parsed | undefined;

const IMPORT_NOTE = "Snapshot import detected: Rebuilds run again.";

/**
 * Run the Plan and wait for the end.
 *
 * The CLI holds one `convex run <module>:apply` at a time and polls `status`
 * beside it for progress lines. The foreground apply drives every Batch
 * inside that call. This matters on an anonymous local deployment, whose
 * backend only runs while a CLI command runs: a background run polled by
 * short commands would get almost no time there.
 *
 * `convex run` drops a call after 300 s, so apply stops after 4 minutes,
 * moves the run to the background and throws Still Running with the run id.
 * The CLI then calls apply again with `resume`, which goes on with the same
 * run. A call that fails without an answer from the function is not a
 * failed run: the CLI reads `status` and keeps waiting while the run lives.
 */
/**
 * The run that a call without an answer started: a live run that was not
 * live before, or a run id on a Step that no Step showed before.
 */
function startedRun(before: Status, after: Status): string | undefined {
	if (after.run?.live) {
		const same = before.run?.live && before.run.id === after.run.id;
		return same ? undefined : after.run.id;
	}
	const seen = new Set(before.steps.map((s) => s.runId));
	return after.steps.find((s) => s.runId !== null && !seen.has(s.runId))
		?.runId as string | undefined;
}

async function follow(
	p: Parsed,
	args: { only?: string; rebuild?: "all" | string[] },
): Promise<number> {
	const t0 = Date.now();
	const json = p.flags.has("--json");
	const timeout = p.flags.has("--timeout")
		? parseDuration(p.flags.get("--timeout") as string)
		: Infinity;
	if (p.flags.has("--no-wait")) {
		const started = await convexRun(p, "apply", { ...args, wait: false });
		if (json) console.log(JSON.stringify(started, null, 2));
		else {
			if (started.restored) console.log(IMPORT_NOTE);
			console.log(`Started run ${started.runId}.${localNote(p, true)}`);
		}
		return 0;
	}
	const shown = new Map<string, string>();
	const show = (steps: StepStatus[], runId: string | undefined) => {
		if (json) return;
		for (const step of steps) {
			const line = stepLine(step);
			if (step.runId === runId && shown.get(step.id) !== line) {
				console.log(line);
				shown.set(step.id, line);
			}
		}
	};
	let importNoted = false;
	const noteImport = () => {
		if (!json && !importNoted) console.log(IMPORT_NOTE);
		importNoted = true;
	};
	const readStatus = (): Promise<Status | null> =>
		read(p, "status", {}).catch(() => null);
	waitingFor = p;
	// What the server showed before the first call. When that call gets no
	// answer, a run this call started is one that was not there before.
	const before = await readStatus();
	let request: object = args;
	let runId: string | undefined;
	let lost = 0;
	for (;;) {
		type End = { result: any } | { error: Error };
		let end: End | undefined;
		const child = convexRun(p, "apply", request).then(
			(result) => (end = { result }),
			(error: Error) => (end = { error }),
		);
		while (!end) {
			await Promise.race([child, new Promise((r) => setTimeout(r, 2000))]);
			if (end) break;
			if (Date.now() - t0 > timeout) {
				console.error(
					`Still running after ${p.flags.get("--timeout")}. The run continues while the deployment's backend runs. Look with ${own(p, "status")}.${localNote(p)}`,
				);
				return 2;
			}
			// Progress is best effort; the apply command decides the outcome.
			const s: Status | null = await convexRun(p, "status", {}).catch(
				() => null,
			);
			if (s?.run) show(s.steps, s.run.id);
		}
		if ("result" in end) {
			const r = end.result;
			if (json) console.log(JSON.stringify(r, null, 2));
			else {
				if (r.restored) noteImport();
				show(r.steps, r.runId);
				console.log(`Done in ${Math.round((Date.now() - t0) / 1000)}s.`);
			}
			return 0;
		}
		const message = end.error.message;
		if (end.error instanceof ServerError) {
			const still = /^Still running: run (\S+) /.exec(message);
			if (!still) {
				console.error(withTarget(message));
				return 1;
			}
			runId = still[1];
			lost = 0;
			if (message.includes(IMPORT_NOTE)) noteImport();
		} else {
			// No answer from the function. The run may be alive, done or failed.
			const s = await readStatus();
			if (!runId && s && before) runId = startedRun(before, s);
			if (!runId) {
				console.error(message);
				if (s?.run?.live) {
					console.error(
						before?.run?.live && before.run.id === s.run.id
							? `Run ${s.run.id} was already working before this apply, so this apply did not start a run. Look with ${own(p, "status")}.`
							: `Run ${s.run.id} is working on the server. Look with ${own(p, "status")}.`,
					);
				}
				return 1;
			}
			if (!s || ++lost > 3) {
				console.error(message);
				return 1;
			}
			if (s.run?.live && s.run.id === runId && !json) {
				console.error(
					`The apply call ended without an answer (${message.split("\n").pop()}). Run ${runId} is still working. Waiting for it.`,
				);
			}
			// Not live any more: `resume` reports how the run ended.
		}
		if (Date.now() - t0 > timeout) {
			console.error(
				`Still running in the background after ${p.flags.get("--timeout")}. Look with ${own(p, "status")}.`,
			);
			return 2;
		}
		// Go on with the same run. `resume` does not request the Rebuilds again
		// and does not run the Seeds again.
		request = { resume: runId, ...(args.only ? { only: args.only } : {}) };
	}
}

async function main(argv: string[]): Promise<number> {
	const p = parse(argv);
	current = p;
	const json = p.flags.has("--json");
	const print = (value: unknown, human: () => void) =>
		json ? console.log(JSON.stringify(value, null, 2)) : human();
	const only = p.flags.get("--only") as string | undefined;
	switch (p.command) {
		case "apply": {
			if (p.flags.has("--dry-run")) {
				const r = await convexRun(p, "apply", { dryRun: true, only });
				print(r, () => {
					for (const s of r.steps as StepStatus[]) {
						console.log(
							`  ${s.id.padEnd(36)} ${s.wouldRun ? "would run" : "skip     "}  ${s.reason ?? ""}`,
						);
						for (const c of s.changes ?? [])
							console.log(`      ${c.op} ${c.table} ${c.id ?? ""}`);
					}
				});
				return 0;
			}
			return await follow(p, { only });
		}
		case "rebuild": {
			const all = p.flags.has("--all");
			if (all && p.positional.length > 0) {
				throw new UsageError(
					"--all and Rebuild ids cannot be combined. Pass --all, or the ids alone.",
				);
			}
			if (!all && p.positional.length === 0) {
				throw new UsageError("rebuild needs --all or one or more Rebuild ids.");
			}
			return await follow(p, { rebuild: all ? "all" : p.positional });
		}
		case "status": {
			const events = p.flags.get("--events") as string | undefined;
			const s: Status = await read(p, "status", events ? { events } : {});
			print(s, () => printStatus(s));
			return 0;
		}
		case "check": {
			if (json) {
				const s: Status = await read(p, "status", {});
				console.log(JSON.stringify(s, null, 2));
				return s.state === "done" ? 0 : 1;
			}
			const s: Status = await read(p, "status", { check: true });
			print(s, () => console.log("Every Step is done."));
			return 0;
		}
		case "mark-done": {
			const id = needOne(p, "Step id");
			const reason = p.flags.get("--reason");
			if (typeof reason !== "string")
				throw new UsageError("mark-done needs --reason <text>.");
			const s: Status = await write(p, "operate", {
				op: "markDone",
				id,
				reason,
			});
			print(s, () => console.log(`Recorded "${id}" as done.`));
			return 0;
		}
		case "reset": {
			const id = needOne(p, "Step id");
			const s: Status = await write(p, "operate", { op: "reset", id });
			print(s, () =>
				console.log(`Reset "${id}". The next apply runs it from the start.`),
			);
			return 0;
		}
		case "cancel": {
			// The cancel names the run this read saw, so it cannot stop a newer
			// run that started meanwhile. A failed read must not block the
			// cancel: then it stops whatever run is there.
			const before: Status | null = await read(p, "status", {}).catch(
				() => null,
			);
			if (before && !before.run) {
				print(before, () => console.log("No run to cancel."));
				return 0;
			}
			const runId = before?.run?.id;
			let s: Status;
			try {
				s = await write(
					p,
					"operate",
					runId ? { op: "cancel", runId } : { op: "cancel" },
				);
			} catch (e) {
				// The run ended between the read and the cancel: nothing to do.
				const ended = `Run ${runId} already ended; nothing to cancel.`;
				if (!(e instanceof ServerError) || !e.message.startsWith(ended))
					throw e;
				const after: Status | null = await read(p, "status", {}).catch(
					() => null,
				);
				print(after ?? { runId, ended: true }, () => console.log(ended));
				return 0;
			}
			print(s, () =>
				console.log(
					runId
						? `Canceled run ${runId}. It stops at the next Batch boundary; apply resumes it.`
						: `Cancel sent. Look with ${own(p, "status")}.`,
				),
			);
			return 0;
		}
		case "adopt": {
			const text = p.flags.get("--expect-count");
			if (typeof text !== "string" || !/^\d+$/.test(text))
				throw new UsageError("adopt needs --expect-count <n>.");
			const n = Number(text);
			const r = await write(p, "adopt", { expectCount: n });
			print(r, () =>
				console.log(
					`Adopted ${r.adopted}; ${r.alreadyDone} were already done.`,
				),
			);
			return 0;
		}
		default:
			throw new UsageError(`Unknown command "${p.command}".`);
	}
}

// Ctrl-C and a deploy system's stop signal end this program, not the run.
for (const [signal, code] of [
	["SIGINT", 130],
	["SIGTERM", 143],
] as const) {
	process.on(signal, () => {
		for (const child of children) child.kill();
		if (waitingFor) {
			console.error(
				`\nInterrupted. The run continues while the deployment's backend runs. Stop it with ${own(waitingFor, "cancel")}. Look with ${own(waitingFor, "status")}.${localNote(waitingFor)}`,
			);
		}
		process.exit(code);
	});
}

main(process.argv.slice(2)).then(
	(code) => {
		// After --timeout the apply command is still waiting. Stopping it does
		// not stop the run on the server.
		for (const child of children) child.kill();
		process.exit(code);
	},
	(e: unknown) => {
		if (e instanceof HelpRequest) {
			console.log(USAGE);
			process.exit(0);
		}
		if (e instanceof UsageError) {
			console.error(e.message + "\n");
			console.error(USAGE);
			process.exit(64);
		}
		console.error(withTarget(e instanceof Error ? e.message : String(e)));
		process.exit(1);
	},
);
