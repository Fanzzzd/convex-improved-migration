// @vitest-environment node
// The command line program against a stand-in for the Convex CLI. A temp
// project gets a fake `convex` package whose script answers `convex run`
// from a scenario file and logs every call. Real deployments are covered by
// e2e/e2e.sh.
import { spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

/** What the fake `convex run` does for one call. */
type Answer = {
	code?: number;
	stdout?: string;
	stderr?: string;
	/** Do not exit; wait to be killed. */
	hang?: boolean;
};
/** Answers per function name, used in order. The last one repeats. */
type Scenario = Record<string, Answer[]>;

const STUB = `
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.STUB_DIR;
const argv = process.argv.slice(2);
const fn = argv.find((a) => /^[\\w/]+:\\w+$/.test(a)).split(":")[1];
const log = path.join(dir, "calls.jsonl");
const seen = fs.existsSync(log)
  ? fs.readFileSync(log, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const n = seen.filter((c) => c.fn === fn).length;
fs.appendFileSync(log, JSON.stringify({ fn, argv }) + "\\n");
const answers = JSON.parse(fs.readFileSync(path.join(dir, "scenario.json"), "utf8"))[fn] || [{}];
const a = answers[Math.min(n, answers.length - 1)];
if (a.stdout) process.stdout.write(a.stdout);
if (a.stderr) process.stderr.write(a.stderr);
if (a.hang) setInterval(() => {}, 1000);
else process.exit(a.code || 0);
`;

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cim-cli-"));
	const pkg = join(dir, "node_modules", "convex");
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(dir, "package.json"), "{}");
	writeFileSync(
		join(pkg, "package.json"),
		JSON.stringify({
			name: "convex",
			bin: { convex: "stub.cjs" },
			exports: { "./package.json": "./package.json" },
		}),
	);
	writeFileSync(join(pkg, "stub.cjs"), STUB);
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

type Call = { fn: string; argv: string[]; args: unknown };
function calls(): Call[] {
	let text = "";
	try {
		text = readFileSync(join(dir, "calls.jsonl"), "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const c = JSON.parse(line) as { fn: string; argv: string[] };
			return { ...c, args: JSON.parse(c.argv.at(-1) ?? "null") };
		});
}

function cli(
	args: string[],
	scenario: Scenario = {},
	options: {
		signalAfterMs?: number;
		signal?: NodeJS.Signals;
		nodeArgs?: string[];
	} = {},
): Promise<{ code: number | null; out: string; err: string }> {
	writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[...(options.nodeArgs ?? []), CLI, ...args],
			{
				cwd: dir,
				env: { ...process.env, STUB_DIR: dir, NODE_NO_WARNINGS: "1" },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let out = "";
		let err = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (err += c));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, out, err }));
		if (options.signalAfterMs) {
			setTimeout(
				() => child.kill(options.signal ?? "SIGINT"),
				options.signalAfterMs,
			);
		}
	});
}

const json = (value: unknown): Answer => ({ stdout: JSON.stringify(value) });
const threw = (message: string): Answer => ({
	code: 1,
	stderr: `✖ Failed to run function "migrations:apply":\nUncaught Error: ${message}\n    at handler (../convex/migrations.ts:1:1)\n`,
});
/** What `convex run` prints when its HTTP call gets no answer for 300 s. */
const dropped: Answer = {
	code: 1,
	stderr: '✖ Failed to run function "migrations:apply":\nError\n',
};
const stepDone = (runId: string) => ({
	id: "backfill",
	kind: "migration",
	state: "done",
	processed: 5,
	skipped: 0,
	reason: "done via ran",
	runId,
	error: null,
});
const applied = (runId: string, restored = false) =>
	json({ ok: true, runId, restored, steps: [stepDone(runId)], orphans: [] });
const status = (
	run: { id: string; live: boolean } | null,
	steps: ReturnType<typeof stepDone>[] = [],
) =>
	json({
		state: run ? "running" : "done",
		run: run && {
			...run,
			mode: "background",
			startedAt: "2026-11-10T00:00:00Z",
		},
		steps,
		orphans: [],
		next: [],
	});
const STILL = (runId: string, note = "") =>
	`Still running: run ${runId} continues in the background after 240s.${note} Keep waiting with: npx convex run migrations:apply '{"resume":"${runId}"}'.`;

describe("usage", () => {
	test("no command and --help print the usage and exit 0", async () => {
		for (const args of [[], ["--help"], ["apply", "--help"], ["help"]]) {
			const r = await cli(args);
			expect(r.code).toBe(0);
			expect(r.out).toContain("Usage: npx convex-improved-migration");
		}
		expect(calls()).toEqual([]);
	});

	test("an option the command does not read is a usage error, and nothing runs", async () => {
		for (const args of [
			["rebuild", "--all", "--dry-run"],
			["status", "--only", "x"],
			["check", "--timeout", "5s"],
			["apply", "--dry-run", "--no-wait"],
			["apply", "--reason", "x"],
			["apply", "--bogus"],
			["apply", "--only", "a", "--only", "b"],
			["apply", "--json", "--json"],
			["rebuild", "--all", "--all"],
			["status", "--prod", "--prod"],
			["status", "--url", "http://a", "--url=http://b"],
			["apply", "extra"],
			["status", "extra"],
			["check", "extra"],
			["cancel", "extra"],
			["adopt", "extra", "--expect-count", "1"],
			["adopt", "--expect-count", ""],
			["adopt", "--expect-count", "1e2"],
			["adopt", "--expect-count", "0x10"],
			["reset", "a", "b"],
			["mark-done", "a", "b", "--reason", "x"],
			["frobnicate"],
		]) {
			const r = await cli(args);
			expect(r.code, args.join(" ")).toBe(64);
			expect(r.err).toContain("Usage:");
		}
		expect((await cli(["rebuild", "--all", "--dry-run"])).err).toContain(
			"--dry-run is not an option of rebuild.",
		);
		expect(calls()).toEqual([]);
	});

	test("every token is used as typed or refused: no value is dropped", async () => {
		const refused: [string[], string][] = [
			[["status", "--prod=false"], "--prod takes no value."],
			[["apply", "--dry-run=false"], "--dry-run takes no value."],
			[["apply", "--no-wait=false"], "--no-wait takes no value."],
			[["status", "--json=true"], "--json takes no value."],
			[["rebuild", "--all=yes"], "--all takes no value."],
			[["status", "--help=x"], "--help takes no value."],
			[
				["mark-done", "a", "--reason", "--prod"],
				'--reason needs a value, and "--prod" is an option. To use it as the value, write --reason=--prod.',
			],
			[["status", "--deployment", "--prod"], "--deployment needs a value"],
			[["reset", "-odd"], 'A Step id that starts with "-" goes after --.'],
			[["apply", "--DRY-RUN"], "Unknown option --DRY-RUN."],
			[["Apply"], 'Unknown command "Apply".'],
			[["apply", "--", "x"], 'apply does not take "x".'],
		];
		for (const [args, message] of refused) {
			const r = await cli(args);
			expect(r.code, args.join(" ")).toBe(64);
			expect(r.err, args.join(" ")).toContain(message);
		}
		expect(calls()).toEqual([]);
		expect((await cli(["status", "--bogus"])).err).not.toContain(
			"goes after --",
		);
		const accepted: [string[], unknown][] = [
			[
				["mark-done", "a", "--reason=--prod"],
				{ op: "markDone", id: "a", reason: "--prod" },
			],
			[
				["mark-done", "a", "--reason", "-h"],
				{ op: "markDone", id: "a", reason: "-h" },
			],
			[["reset", "--", "-odd"], { op: "reset", id: "-odd" }],
		];
		for (const [args, sent] of accepted) {
			const r = await cli(args, { operate: [status(null)] });
			expect(r.code, args.join(" ")).toBe(0);
			expect(calls().at(-1)?.args).toEqual(sent);
		}
	}, 30_000);

	test("deployment selectors pass through to convex run", async () => {
		const r = await cli(
			[
				"status",
				"--deployment",
				"dev:tidy-fox-1",
				"--prod",
				"--module",
				"ops/plan",
			],
			{ status: [status(null)] },
		);
		expect(r.code).toBe(0);
		expect(calls()[0]?.argv).toEqual([
			"run",
			"--deployment",
			"dev:tidy-fox-1",
			"--prod",
			"ops/plan:status",
			"{}",
		]);
	});
});

describe("apply", () => {
	test("after Still Running it goes on with the same run and does not send rebuild again", async () => {
		const r = await cli(["rebuild", "--all"], {
			apply: [
				threw(STILL("run1", " Snapshot import detected: Rebuilds run again.")),
				threw(STILL("run1", " Snapshot import detected: Rebuilds run again.")),
				applied("run1", true),
			],
			status: [status({ id: "run1", live: true })],
		});
		expect(r.code).toBe(0);
		expect(r.out.match(/Snapshot import detected/g)).toHaveLength(1);
		expect(r.out).toContain("backfill");
		expect(r.out).toMatch(/Done in \d+s\./);
		expect(
			calls()
				.filter((c) => c.fn === "apply")
				.map((c) => c.args),
		).toEqual([{ rebuild: "all" }, { resume: "run1" }, { resume: "run1" }]);
	});

	test("resume keeps --only", async () => {
		await cli(["apply", "--only", "backfill"], {
			apply: [threw(STILL("run1")), applied("run1")],
		});
		expect(
			calls()
				.filter((c) => c.fn === "apply")
				.map((c) => c.args),
		).toEqual([{ only: "backfill" }, { resume: "run1", only: "backfill" }]);
	});

	test("a Step failure exits 1 with the message, without the stack", async () => {
		const r = await cli(["apply"], {
			apply: [threw('Step "backfill" (migration) failed on batch 2.')],
		});
		expect(r.code).toBe(1);
		expect(r.err.trim()).toBe('Step "backfill" (migration) failed on batch 2.');
	});

	test("a dropped first call that reached the server follows its own run", async () => {
		const r = await cli(["apply"], {
			apply: [dropped, applied("run7")],
			// Before the call no run; after it, the run this call started.
			status: [status(null), status({ id: "run7", live: true })],
		});
		expect(r.code).toBe(0);
		expect(r.err).toContain("Run run7 is still working. Waiting for it.");
		expect(
			calls()
				.filter((c) => c.fn === "apply")
				.map((c) => c.args),
		).toEqual([{}, { resume: "run7" }]);
	});

	test("the status read before the first call is tried again when it fails", async () => {
		const r = await cli(["apply"], {
			apply: [dropped, applied("run7")],
			status: [
				{ code: 1, stderr: "✖ Could not reach the deployment\n" },
				status(null),
				status({ id: "run7", live: true }),
			],
		});
		expect(r.code).toBe(0);
		expect(
			calls()
				.filter((c) => c.fn === "apply")
				.map((c) => c.args),
		).toEqual([{}, { resume: "run7" }]);
	});

	test("a dropped first call does not attach to a run that was working before it", async () => {
		const r = await cli(["rebuild", "--all"], {
			apply: [dropped, applied("old")],
			status: [status({ id: "old", live: true })],
		});
		expect(r.code).toBe(1);
		expect(r.err).toContain(
			"Run old was already working before this apply, so this apply did not start a run.",
		);
		expect(r.out).not.toContain("Done");
		expect(
			calls()
				.filter((c) => c.fn === "apply")
				.map((c) => c.args),
		).toEqual([{ rebuild: "all" }]);
	});

	test("a dropped first call whose run already ended reports how it ended", async () => {
		const r = await cli(["apply"], {
			apply: [dropped, threw('Step "backfill" (migration) failed on batch 3.')],
			status: [
				status(null, [stepDone("run1")]),
				status(null, [stepDone("run9")]),
			],
		});
		expect(r.code).toBe(1);
		expect(r.err).toContain('Step "backfill" (migration) failed on batch 3.');
		expect(
			calls()
				.filter((c) => c.fn === "apply")
				.map((c) => c.args),
		).toEqual([{}, { resume: "run9" }]);
	});

	test("unreadable output of a finished call is checked against the server", async () => {
		const r = await cli(["apply"], {
			apply: [{ stdout: "not json" }, applied("run1")],
			status: [status(null), status({ id: "run1", live: true })],
		});
		expect(r.code).toBe(0);
		expect(
			calls()
				.filter((c) => c.fn === "apply")
				.map((c) => c.args),
		).toEqual([{}, { resume: "run1" }]);
	});

	test("a dropped call after the run ended asks the server how it ended", async () => {
		const r = await cli(["apply"], {
			apply: [
				threw(STILL("run1")),
				dropped,
				threw('Step "backfill" (migration) failed on batch 9.'),
			],
			status: [status(null)],
		});
		expect(r.code).toBe(1);
		expect(r.err).toContain('Step "backfill" (migration) failed on batch 9.');
		expect(
			calls()
				.filter((c) => c.fn === "apply")
				.map((c) => c.args),
		).toEqual([{}, { resume: "run1" }, { resume: "run1" }]);
	});

	test("a call that fails with no run in sight exits 1 with the error", async () => {
		const r = await cli(["apply"], {
			apply: [{ code: 1, stderr: "✖ Could not reach the deployment\n" }],
			status: [status(null)],
		});
		expect(r.code).toBe(1);
		expect(r.err).toContain("Could not reach the deployment");
		expect(calls().filter((c) => c.fn === "apply")).toHaveLength(1);
	});

	test("--timeout exits 2 and says the run continues", async () => {
		const r = await cli(["apply", "--timeout", "1s"], {
			apply: [{ hang: true }],
			status: [status({ id: "run1", live: true })],
		});
		expect(r.code).toBe(2);
		expect(r.err).toContain(
			"Still running after 1s. The run continues while the deployment's backend runs.",
		);
		expect(r.err).not.toContain("local deployment");
	});

	test("on a local deployment the stop messages say the run needs the local backend", async () => {
		writeFileSync(
			join(dir, ".env.local"),
			"CONVEX_DEPLOYMENT=anonymous:anonymous-demo\n",
		);
		const scenario = {
			apply: [{ hang: true }],
			status: [status({ id: "run1", live: true })],
		};
		const timedOut = await cli(["apply", "--timeout", "1s"], scenario);
		const stopped = await cli(["apply"], scenario, {
			signalAfterMs: 1500,
			signal: "SIGTERM",
		});
		for (const r of [timedOut, stopped]) {
			expect(r.err).toContain(
				"On a local deployment without npx convex dev running, the backend is a process that convex run started. The run moves only while that process lives.",
			);
		}
		const prod = await cli(["apply", "--timeout", "1s", "--prod"], scenario);
		expect(prod.err).not.toContain("local deployment");
	}, 20_000);

	test("--no-wait --json prints only JSON", async () => {
		const r = await cli(["apply", "--no-wait", "--json"], {
			apply: [applied("run1", true)],
		});
		expect(r.code).toBe(0);
		expect(JSON.parse(r.out)).toMatchObject({ runId: "run1", restored: true });
		expect(calls()[0]?.args).toEqual({ wait: false });
	});

	test("SIGINT and SIGTERM stop the program, name cancel, and say the run continues", async () => {
		for (const [signal, code] of [
			["SIGINT", 130],
			["SIGTERM", 143],
		] as const) {
			const r = await cli(
				["apply", "--module", "ops/plan"],
				{
					apply: [{ hang: true }],
					status: [status({ id: "run1", live: true })],
				},
				{ signalAfterMs: 1500, signal },
			);
			expect(r.code).toBe(code);
			expect(r.err).toContain(
				"Interrupted. The run continues while the deployment's backend runs. Stop it with npx convex-improved-migration cancel --module ops/plan.",
			);
		}
	});
});

describe("cancel", () => {
	test("says so when no run exists, and sends no cancel", async () => {
		const r = await cli(["cancel"], {
			status: [status(null)],
			operate: [status(null)],
		});
		expect(r.code).toBe(0);
		expect(r.out.trim()).toBe("No run to cancel.");
		expect(calls().map((c) => c.fn)).toEqual(["status"]);
	});

	test("still cancels when the status read before it fails", async () => {
		const r = await cli(["cancel"], {
			status: [{ code: 1, stderr: "✖ Could not reach the deployment\n" }],
			operate: [status(null)],
		});
		expect(r.code).toBe(0);
		expect(r.out.trim()).toBe(
			"Cancel sent. Look with npx convex-improved-migration status.",
		);
		// The read is tried 3 times, 2 s apart, then the cancel goes ahead
		// without a run id.
		expect(calls().map((c) => c.fn)).toEqual([
			"status",
			"status",
			"status",
			"operate",
		]);
		expect(calls().at(-1)?.args).toEqual({ op: "cancel" });
	}, 15_000);

	test("is tried again when the server reports a write conflict", async () => {
		const conflict: Answer = {
			code: 1,
			stderr:
				'✖ Failed to run function "migrations:operate":\nUncaught Error: Documents read from or written to the "lease" table changed while this mutation was being run and on every subsequent retry.\n',
		};
		const r = await cli(["cancel"], {
			status: [status({ id: "run1", live: true })],
			operate: [conflict, status(null)],
		});
		expect(r.code).toBe(0);
		expect(calls().filter((c) => c.fn === "operate")).toHaveLength(2);
	});

	test("says so when the run it saw ended before the cancel landed", async () => {
		const r = await cli(["cancel"], {
			status: [status({ id: "run1", live: true }), status(null)],
			operate: [
				{
					code: 1,
					stderr:
						'✖ Failed to run function "migrations:operate":\nUncaught Error: Run run1 already ended; nothing to cancel.\n    at handler (../x.ts:1:1)\n',
				},
			],
		});
		expect(r.code).toBe(0);
		expect(r.out.trim()).toBe("Run run1 already ended; nothing to cancel.");
	});

	test("cancels the run it saw, by id, and confirms", async () => {
		const r = await cli(["cancel"], {
			status: [status({ id: "run1", live: true })],
			operate: [status(null)],
		});
		expect(r.out).toContain(
			"Canceled run run1. It stops at the next Batch boundary",
		);
		expect(calls().at(-1)?.args).toEqual({ op: "cancel", runId: "run1" });
	});
});

describe("windows", () => {
	test("with no local convex package the CLI refuses instead of using a shell", async () => {
		rmSync(join(dir, "node_modules"), { recursive: true, force: true });
		const preload = join(dir, "win32.cjs");
		writeFileSync(
			preload,
			'Object.defineProperty(process, "platform", { value: "win32" });\n',
		);
		const r = await cli(["status"], {}, { nodeArgs: ["--require", preload] });
		expect(r.code).not.toBe(0);
		expect(r.err).toContain(
			"Could not find the convex package in this project. Install it with npm install convex",
		);
		expect(calls()).toEqual([]);
	});
});

describe("status, check and mark-done", () => {
	const step = (fields: Record<string, unknown>) => ({
		id: "backfill",
		kind: "migration",
		processed: 0,
		skipped: 0,
		reason: null,
		runId: null,
		error: null,
		...fields,
	});
	const plan = (steps: unknown[], next: string[] = []) =>
		json({ state: "pending", run: null, steps, orphans: [], next });

	test("the human status shows the counts, the cause of a failure and the reason of every state", async () => {
		const r = await cli(["status"], {
			status: [
				plan(
					[
						step({
							id: "canceled-step",
							state: "pending",
							processed: 3000,
							skipped: 2000,
							reason: "canceled; apply resumes it",
						}),
						step({
							id: "failed-step",
							state: "failed",
							error: {
								message: "amount must be positive",
								batch: 1,
								batchSize: 100,
								processed: 0,
							},
						}),
						step({
							id: "reset-step",
							state: "pending",
							reason: "reset; apply runs it from the start",
						}),
					],
					["npx convex-improved-migration status --events failed-step"],
				),
			],
		});
		expect(r.code).toBe(0);
		const line = (id: string) =>
			r.out.split("\n").find((l) => l.trim().startsWith(id)) ?? "";
		expect(line("canceled-step")).toMatch(
			/pending +3000 processed, 2000 skipped +canceled; apply resumes it$/,
		);
		expect(line("failed-step")).toMatch(
			/failed +0 processed +amount must be positive$/,
		);
		expect(line("reset-step")).toMatch(
			/pending +reset; apply runs it from the start$/,
		);
		expect(r.out).toContain(
			"Next:\n  npx convex-improved-migration status --events failed-step",
		);
	});

	test("check --json prints JSON and exits 1 when a Step is not done", async () => {
		const r = await cli(["check", "--json"], {
			status: [plan([step({ state: "pending", reason: "never ran" })])],
		});
		expect(r.code).toBe(1);
		expect(JSON.parse(r.out)).toMatchObject({ state: "pending" });
	});

	test("an empty value is a usage error before any call", async () => {
		for (const args of [
			["mark-done", "backfill", "--reason", ""],
			["mark-done", "backfill", "--reason=  "],
			["apply", "--only", ""],
			["status", "--events="],
		]) {
			const r = await cli(args);
			expect(r.code, args.join(" ")).toBe(64);
			expect(r.err).toContain("needs a value.");
		}
		expect(calls()).toEqual([]);
	});

	test("rebuild with both --all and ids says they cannot be combined", async () => {
		for (const args of [
			["rebuild", "--all", "--", "x"],
			["rebuild", "x", "--all"],
		]) {
			const r = await cli(args);
			expect(r.code, args.join(" ")).toBe(64);
			expect(r.err).toContain("--all and Rebuild ids cannot be combined");
		}
		const none = await cli(["rebuild"]);
		expect(none.code).toBe(64);
		expect(none.err).toContain("rebuild needs --all or one or more");
		expect(calls()).toEqual([]);
	}, 20_000);

	test("a zero --timeout is a usage error before any call", async () => {
		for (const value of ["0", "0s", "0.0m", "0ms"]) {
			const r = await cli(["apply", "--timeout", value]);
			expect(r.code, value).toBe(64);
			expect(r.err).toContain("--timeout must be more than 0");
		}
		const negative = await cli(["apply", "--timeout=-5s"]);
		expect(negative.code).toBe(64);
		expect(calls()).toEqual([]);
	}, 20_000);
});

describe("hints carry the deployment flags", () => {
	test("a server hint after --prod says to add it; the admin key stays hidden", async () => {
		const r = await cli(["apply", "--prod"], {
			status: [status(null)],
			apply: [
				threw("Step x failed. Next: npx convex-improved-migration apply"),
			],
		});
		expect(r.code).toBe(1);
		expect(r.err).toContain("Add --prod to each command above.");
		const keyed = await cli(
			["apply", "--url", "http://h", "--admin-key", "s3cret"],
			{
				status: [status(null)],
				apply: [threw("Next: npx convex-improved-migration apply")],
			},
		);
		expect(keyed.err).toContain(
			"Add --url http://h --admin-key <key> to each command above.",
		);
		expect(keyed.err).not.toContain("s3cret");
		const plain = await cli(["apply"], {
			status: [status(null)],
			apply: [threw("Next: npx convex-improved-migration apply")],
		});
		expect(plain.err).not.toContain("to each command above");
	}, 20_000);

	test("the CLI's own hints include the flags", async () => {
		const r = await cli(["apply", "--timeout", "1s", "--prod"], {
			apply: [{ hang: true }],
			status: [status({ id: "run1", live: true })],
		});
		expect(r.code).toBe(2);
		expect(r.err).toContain(
			"Look with npx convex-improved-migration status --prod.",
		);
	});

	test("--no-wait on a local deployment says the run needs a running backend", async () => {
		writeFileSync(
			join(dir, ".env.local"),
			"CONVEX_DEPLOYMENT=local:local-demo\n",
		);
		const r = await cli(["apply", "--no-wait"], { apply: [applied("run1")] });
		expect(r.code).toBe(0);
		expect(r.out).toContain("Started run run1.");
		expect(r.out).toContain(
			"the backend stops when this command exits. The run moves only while npx convex dev or a later command keeps the backend up.",
		);
	});

	test("a missing adopt export names the line to add", async () => {
		const r = await cli(["adopt", "--expect-count", "2"], {
			adopt: [
				{
					code: 1,
					stderr:
						"✖ Failed to run function \"migrations:adopt\":\nError: [Request ID: 1] Server Error\nCould not find function for 'migrations:adopt'.\n",
				},
			],
		});
		expect(r.code).toBe(1);
		expect(r.err).toContain(
			"Add `export const adopt = m.adopt(components.<name>)` beside the Plan",
		);
	});

	test("a wrong --module is final and names --module", async () => {
		const r = await cli(["status", "--module", "nope"], {
			status: [
				{
					code: 1,
					stderr:
						"✖ Failed to run function \"nope:status\":\nError: [Request ID: 1] Server Error\nCould not find function for 'nope:status'. Did you forget to run `npx convex dev`?\n\nAvailable functions:\n",
				},
			],
		});
		expect(r.code).toBe(1);
		expect(r.err).toContain("Could not find function for 'nope:status'.");
		expect(r.err).toContain(
			"If the Plan is in another file, pass --module <file>",
		);
		expect(calls()).toHaveLength(1);
	});
});
