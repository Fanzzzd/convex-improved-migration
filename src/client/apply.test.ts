// The apply action against a stand-in for the component, to reach failures
// that a test deployment cannot produce on demand, such as a cleanup call
// that fails after the run already has its outcome.
import { defineSchema, defineTable } from "convex/server";
import { ConvexError, v } from "convex/values";
import { describe, expect, test, vi } from "vitest";
import type { ComponentApi } from "../component/_generated/component.js";
import { DRY_RUN } from "../shared.js";
import { defineMigrations } from "./index.js";

vi.mock("convex/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("convex/server")>()),
	createFunctionHandle: async () => "function://runStep",
}));

const schema = defineSchema({
	users: defineTable({ name: v.string() }),
	nameCounts: defineTable({ count: v.number() }),
});

const THROTTLE =
	"Too many writes per second. Your deployment is limited to 4 MiB bytes written per second.";

const FAILED = {
	status: "failed",
	failure: {
		name: "backfill",
		kind: "migration",
		error: { message: "bad row", batch: 1, batchSize: 10, processed: 0 },
		later: [],
	},
};

/** Component functions by name. Each answer is a value or a function of the call count. */
type Fake = Record<string, (n: number) => unknown>;

function applyWith(fake: Fake, options: { foregroundBudgetMs?: number } = {}) {
	const calls: { name: string; args: Record<string, unknown> }[] = [];
	const component = {
		lib: new Proxy({}, { get: (_target, name) => name }),
	} as unknown as ComponentApi;
	const m = defineMigrations(component, { schema, ...options });
	const plan = m.plan([
		m.migrate("backfill", { table: "users", run: () => ({ name: "x" }) }),
		m.rebuild("names", {
			version: 2,
			table: "users",
			clear: "nameCounts",
			run: async () => {},
		}),
	]);
	const counts = new Map<string, number>();
	const call = async (ref: unknown, args: Record<string, unknown> = {}) => {
		// Component functions are names here; runStep is the app's reference.
		const name = typeof ref === "string" ? ref : "runStep";
		calls.push({ name, args });
		const n = counts.get(name) ?? 0;
		counts.set(name, n + 1);
		const answer = fake[name];
		if (!answer) throw new Error(`unexpected call to ${name}`);
		return answer(n);
	};
	const ctx = {
		runMutation: (ref: unknown, args?: Record<string, unknown>) =>
			call(ref, args),
		runQuery: (ref: unknown, args?: Record<string, unknown>) => call(ref, args),
	};
	type Handler<R> = { _handler: (ctx: unknown, args: object) => Promise<R> };
	const apply = (plan.functions.apply as unknown as Handler<{ ok: boolean }>)
		._handler;
	const status = (
		plan.functions.status as unknown as Handler<{
			steps: { id: string; state: string; reason: string | null }[];
		}>
	)._handler;
	const operate = (
		plan.functions.operate as unknown as Handler<{
			steps: { id: string; state: string; reason: string | null }[];
		}>
	)._handler;
	return {
		run: (args: object = {}) => apply(ctx, args),
		status: () => status(ctx, {}),
		operate: (args: object) => operate(ctx, args),
		counts,
		calls,
	};
}

const prepare = () => ({ unfinishedOrphans: [], restored: false, holder: "h" });
const status = () => ({
	restoreSuspected: false,
	rows: [],
	lease: null,
	events: [],
});

describe("a failing cleanup call does not replace the outcome", () => {
	test("a Step failure stays the error when release fails", async () => {
		const { run } = applyWith({
			prepare,
			advance: () => FAILED,
			release: () => {
				throw new Error("Server error: lost the connection");
			},
		});
		await expect(run()).rejects.toThrow('Step "backfill" (migration) failed');
	});

	test("a finished run stays a success when release fails", async () => {
		const { run } = applyWith({
			prepare,
			advance: () => ({ status: "done" }),
			status,
			release: () => {
				throw new Error(THROTTLE);
			},
		});
		await expect(run()).resolves.toMatchObject({ ok: true });
	});

	test("the handover waits out a write throttle and reports Still Running", async () => {
		const { run, counts } = applyWith(
			{
				prepare,
				advance: () => ({ status: "progress", current: "backfill" }),
				handOff: (n) => {
					if (n === 0) throw new Error(THROTTLE);
					return "handed";
				},
			},
			{ foregroundBudgetMs: 0 },
		);
		await expect(run()).rejects.toThrow(/^Still running: run \S+ continues/);
		expect(counts.get("handOff")).toBe(2);
		expect(counts.get("release")).toBeUndefined();
	});
});

describe("a suspected import starts a Rebuild over, in status and the dry run", () => {
	const rebuildRow = (state: string, batches: number) => ({
		name: "names",
		kind: "rebuild",
		state,
		via: null,
		version: "2",
		rebuildRequested: false,
		error:
			state === "failed"
				? { message: "boom", batch: 2, batchSize: 10, processed: 10 }
				: null,
		reason: null,
		runId: "old",
		startedAt: 1,
		doneAt: null,
		updatedAt: 1,
		phase: "migrate",
		processed: 10,
		skipped: 0,
		batches,
		batchSize: 10,
		notMigrated: null,
		cursor: "saved",
		verified: null,
	});
	const imported = (state: string) => () => ({
		restoreSuspected: true,
		rows: [rebuildRow(state, 1)],
		lease: null,
		events: [],
	});

	test.each([
		["failed", "failed", "snapshot import suspected; apply starts it over"],
		[
			"pending",
			"pending",
			"canceled; snapshot import suspected; apply starts it over",
		],
	])("%s Rebuild", async (state, shown, reason) => {
		const { status, run, calls } = applyWith({
			status: imported(state),
			prepare: () => ({ unfinishedOrphans: [], restored: false, holder: null }),
			runStep: () => {
				throw new ConvexError({
					kind: DRY_RUN,
					processed: 1,
					skipped: 0,
					clearDone: true,
					changes: [],
				});
			},
		});
		const names = (await status()).steps.find((x) => x.id === "names")!;
		expect(names).toMatchObject({ state: shown, reason });
		await run({ dryRun: true, only: "names" });
		// The preview runs the clear and starts at the first page.
		expect(calls.find((c) => c.name === "runStep")!.args).toMatchObject({
			cursor: null,
			clearFirst: true,
		});
	});
});

describe("a cancel that lands just before the handover", () => {
	test("reads as Canceled, not as a takeover", async () => {
		const { run } = applyWith(
			{
				prepare,
				advance: () => ({ status: "progress", current: "backfill" }),
				handOff: () => "canceled",
				release: () => null,
			},
			{ foregroundBudgetMs: 0 },
		);
		await expect(run()).rejects.toThrow(
			/^Canceled\. The interrupted Step keeps its cursor/,
		);
	});
});

describe("what resume says about a run that ended", () => {
	const resumed = (ended: object) =>
		applyWith({
			resume: () => ({ holder: null, restored: false, retries: 0, ended }),
			status,
		}).run({ resume: "R" });

	test.each([
		[
			{ outcome: "stalled" },
			"Run R stopped: its background driver ended 3 times in a row without progress. npx convex-improved-migration apply continues the work.",
		],
		[
			{ outcome: "taken over", by: "B" },
			"Another apply (run B) took over run R. Check with npx convex-improved-migration status.",
		],
		[
			{ outcome: "canceled" },
			"Canceled. The interrupted Step keeps its cursor; npx convex-improved-migration apply resumes it.",
		],
		[
			{ outcome: null },
			"Run R ended before the Plan finished; the Plan is pending. npx convex-improved-migration apply continues it.",
		],
	])("%o", async (ended, message) => {
		await expect(resumed(ended)).rejects.toThrow(message);
	});

	test("failed: the recorded failure", async () => {
		await expect(
			resumed({ outcome: "failed", failure: FAILED.failure }),
		).rejects.toThrow('Step "backfill" (migration) failed on batch 1');
	});

	test("done: the result of the run", async () => {
		await expect(resumed({ outcome: "done" })).resolves.toMatchObject({
			ok: true,
			runId: "R",
		});
	});
});

describe("operator commands against a busy driver", () => {
	const CONFLICT =
		'Documents read from or written to the "lease" table changed while this mutation was being run and on every subsequent retry.';

	test("cancel is tried again after a write conflict", async () => {
		const { operate, counts } = applyWith({
			cancel: (n) => {
				if (n === 0) throw new Error(CONFLICT);
				return "backfill";
			},
			status,
		});
		await expect(operate({ op: "cancel" })).resolves.toMatchObject({
			steps: expect.any(Array),
		});
		expect(counts.get("cancel")).toBe(2);
	});

	test("reset is tried again and keeps its friendly refusal", async () => {
		const { operate } = applyWith({
			reset: (n) => {
				if (n === 0) throw new Error(CONFLICT);
				return "running";
			},
			status,
		});
		await expect(operate({ op: "reset", id: "backfill" })).rejects.toThrow(
			/^Refusing to reset "backfill": a run is working on it right now/,
		);
	});
});

describe("a Rebuild that would clear its own source table", () => {
	test("is refused when the Plan is defined", () => {
		const component = {} as unknown as ComponentApi;
		const m = defineMigrations(component, { schema });
		expect(() =>
			m.rebuild("names", {
				version: 1,
				table: "users",
				clear: "users",
				run: async () => {},
			}),
		).toThrow(
			'Rebuild "names" clears "users", the table it reads. clear must name the derived table it rebuilds.',
		);
	});
});
