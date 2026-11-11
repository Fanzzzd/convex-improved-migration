import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	retryTransient,
	runLoop,
	startOver,
	stepCommand,
	type AdvanceResult,
	type Throttle,
} from "./shared.js";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const CONFLICT =
	'Documents read from or written to the "lease" table changed while this mutation was being run and on every subsequent retry.';
const THROTTLE =
	"Too many writes per second. Your deployment is limited to 4 MiB bytes written per second.";

/** Run the loop with an `advance` that throws `errors` first, then is done. */
async function loopWith(errors: string[]) {
	const seen: (Throttle | undefined)[] = [];
	const aborts: string[] = [];
	const outcome = runLoop(
		{
			advance: async (throttled): Promise<AdvanceResult> => {
				seen.push(throttled);
				const next = errors.shift();
				if (next) throw new Error(next);
				return { status: "done" };
			},
			recordAbort: async (message) => {
				aborts.push(message);
				return { retry: false, failure: null };
			},
		},
		// Longer than every backoff added up, so the deadline plays no part.
		Date.now() + 600_000,
	);
	// Let the loop reject without an unhandled rejection while timers run.
	outcome.catch(() => {});
	await vi.runAllTimersAsync();
	return { outcome, seen, aborts };
}

describe("runLoop", () => {
	test("waits and retries the same unit on a write throttle", async () => {
		const { outcome, seen, aborts } = await loopWith([THROTTLE, THROTTLE]);
		expect(await outcome).toEqual({ status: "done" });
		expect(aborts).toEqual([]);
		expect(seen[2]).toMatchObject({ retries: 2, waitedMs: 3000 });
	});

	test("waits and retries the same unit on a write conflict", async () => {
		const { outcome, seen, aborts } = await loopWith([CONFLICT]);
		expect(await outcome).toEqual({ status: "done" });
		expect(aborts).toEqual([]);
		expect(seen[1]).toMatchObject({ retries: 1, waitedMs: 1000 });
		expect(seen[1]!.message).toContain("changed while this mutation");
	});

	test("reports a cancel that recordAbort found, not the unit's error", async () => {
		const outcome = runLoop(
			{
				advance: async (): Promise<AdvanceResult> => {
					throw new Error("boom");
				},
				recordAbort: async () => ({ retry: false, stopped: "canceled" }),
			},
			Date.now() + 600_000,
		);
		expect(await outcome).toEqual({ status: "canceled" });
	});

	test("records any other error as an abort and rethrows it", async () => {
		const { outcome, aborts } = await loopWith(["boom"]);
		await expect(outcome).rejects.toThrow("boom");
		expect(aborts).toEqual(["boom"]);
	});

	test("hands over at the deadline, also while it waits on a throttle", async () => {
		const seen: (Throttle | undefined)[] = [];
		const outcome = runLoop(
			{
				advance: async (throttled): Promise<AdvanceResult> => {
					seen.push(throttled);
					throw new Error(THROTTLE);
				},
				recordAbort: async () => ({ retry: false, failure: null }),
			},
			Date.now() + 2500,
		);
		await vi.runAllTimersAsync();
		// Waits of 1 s and 2 s, then the deadline has passed. The waits go
		// with the handover, so they are recorded.
		expect(await outcome).toEqual({
			status: "budget",
			retries: 2,
			throttled: {
				retries: 2,
				waitedMs: 3000,
				message: expect.stringContaining("Too many writes per second"),
			},
		});
		expect(seen).toHaveLength(2);
	});

	test("hands over at the deadline while recording an abort is throttled", async () => {
		let aborts = 0;
		const outcome = runLoop(
			{
				advance: async (): Promise<AdvanceResult> => {
					throw new Error("boom");
				},
				recordAbort: async () => {
					aborts++;
					throw new Error(THROTTLE);
				},
			},
			Date.now() + 2500,
		);
		outcome.catch(() => {});
		await vi.runAllTimersAsync();
		expect(await outcome).toMatchObject({ status: "budget" });
		expect(aborts).toBe(2);
	});

	test("hands waits on a throttle to recordAbort when the retried unit fails", async () => {
		const handed: (Throttle | undefined)[] = [];
		const outcome = runLoop(
			{
				advance: async (throttled): Promise<AdvanceResult> => {
					throw new Error(throttled ? "boom" : THROTTLE);
				},
				recordAbort: async (_message, throttled) => {
					handed.push(throttled);
					return {
						retry: false,
						failure: {
							name: "s",
							kind: "migration",
							error: { message: "boom", batch: 1, batchSize: 1, processed: 0 },
							later: [],
						},
					};
				},
			},
			Date.now() + 600_000,
		);
		await vi.runAllTimersAsync();
		expect(await outcome).toMatchObject({ status: "failed" });
		expect(handed).toEqual([
			expect.objectContaining({ retries: 1, waitedMs: 1000 }),
		]);
	});

	test("counts the throttle retries of earlier drivers of the run", async () => {
		let calls = 0;
		const outcome = runLoop(
			{
				advance: async (): Promise<AdvanceResult> => {
					calls++;
					throw new Error(THROTTLE);
				},
				recordAbort: async () => ({ retry: false, failure: null }),
			},
			Date.now() + 600_000,
			7,
		);
		outcome.catch(() => {});
		await vi.runAllTimersAsync();
		await expect(outcome).rejects.toThrow(/Too many writes per second/);
		expect(calls).toBe(2);
	});

	test("a chain of short Drivers under a permanent throttle fails after 8 retries in a row", async () => {
		// Each Driver gets a 2.5 s budget: about two waits, then a handover.
		let retries = 0;
		let drivers = 0;
		let advances = 0;
		for (; drivers < 20; drivers++) {
			const outcome = runLoop(
				{
					advance: async (): Promise<AdvanceResult> => {
						advances++;
						throw new Error(THROTTLE);
					},
					recordAbort: async () => {
						throw new Error(THROTTLE);
					},
				},
				Date.now() + 2500,
				retries,
			);
			outcome.catch(() => {});
			await vi.runAllTimersAsync();
			const last = await outcome.catch(() => null);
			if (last === null) break;
			expect(last.status).toBe("budget");
			if (last.status !== "budget") break;
			retries = last.retries;
		}
		expect(drivers).toBeLessThan(20);
		// The first try plus 8 retries, counted across every Driver.
		expect(advances).toBe(9);
	});

	test("gives up on a throttle that never ends", async () => {
		const { outcome, aborts } = await loopWith(Array(20).fill(THROTTLE));
		await expect(outcome).rejects.toThrow(/Too many writes per second/);
		expect(aborts).toHaveLength(1);
	});
});

describe("retryTransient", () => {
	async function attempt(failures: number, message: string) {
		let calls = 0;
		const result = retryTransient(async () => {
			if (calls++ < failures) throw new Error(message);
			return "taken";
		});
		result.catch(() => {});
		await vi.runAllTimersAsync();
		return { result, calls: () => calls };
	}

	test("tries again after a write conflict", async () => {
		const { result, calls } = await attempt(3, CONFLICT);
		expect(await result).toBe("taken");
		expect(calls()).toBe(4);
	});

	test("tries again after a write throttle", async () => {
		const { result, calls } = await attempt(2, THROTTLE);
		expect(await result).toBe("taken");
		expect(calls()).toBe(3);
	});

	test("gives up after six tries", async () => {
		const { result, calls } = await attempt(99, CONFLICT);
		await expect(result).rejects.toThrow(/changed while this mutation/);
		expect(calls()).toBe(6);
	});

	test("does not retry another error", async () => {
		const { result, calls } = await attempt(1, "boom");
		await expect(result).rejects.toThrow("boom");
		expect(calls()).toBe(1);
	});
});

describe("startOver", () => {
	const rebuild = { kind: "rebuild" as const, version: "2" };
	const migration = { kind: "migration" as const };
	const row = (state: string, more: object = {}) => ({
		state,
		version: "2",
		runId: "r1",
		...more,
	});
	// [entry, row, has progress, context, expected]
	const cases: [
		string,
		Parameters<typeof startOver>,
		{ over: boolean; why: string | null },
	][] = [
		["never ran", [rebuild, null, false], { over: true, why: null }],
		[
			"failed Migration",
			[migration, row("failed"), true],
			{ over: false, why: null },
		],
		[
			"canceled Migration",
			[migration, row("pending"), true],
			{ over: false, why: null },
		],
		[
			"reset Migration",
			[migration, row("pending"), false],
			{ over: true, why: null },
		],
		[
			"Migration ignores an import",
			[migration, row("failed"), true, { importSuspected: true }],
			{ over: false, why: null },
		],
		[
			"failed Rebuild",
			[rebuild, row("failed"), true],
			{ over: false, why: null },
		],
		[
			"canceled Rebuild",
			[rebuild, row("pending"), true],
			{ over: false, why: null },
		],
		[
			"done Rebuild",
			[rebuild, row("done"), false],
			{ over: true, why: "rebuild" },
		],
		...(["failed", "pending", "done", "running"] as const).flatMap(
			(
				state,
			): [
				string,
				Parameters<typeof startOver>,
				{ over: boolean; why: string | null },
			][] => [
				[
					`${state} Rebuild, version bump`,
					[rebuild, row(state, { version: "1" }), true],
					{ over: true, why: "version 1 -> 2" },
				],
				[
					`${state} Rebuild, rebuild requested`,
					[rebuild, row(state, { rebuildRequested: true }), true],
					{ over: true, why: "rebuild requested" },
				],
				[
					`${state} Rebuild, import suspected`,
					[rebuild, row(state), true, { importSuspected: true }],
					{ over: true, why: "snapshot import suspected" },
				],
			],
		),
		[
			"Seed in a new run",
			[{ kind: "seed" }, row("done"), true, { runId: "r2" }],
			{ over: true, why: null },
		],
		[
			"Seed in its own run",
			[{ kind: "seed" }, row("running"), true, { runId: "r1" }],
			{ over: false, why: null },
		],
	];
	test.each(cases)("%s", (_name, args, expected) => {
		expect(startOver(...args)).toEqual(expected);
	});
});

describe("stepCommand", () => {
	test("puts the id after the command, and after -- when it starts with -", () => {
		expect(stepCommand("reset", "backfill")).toBe("reset backfill");
		expect(stepCommand("mark-done", "backfill", ' --reason "..."')).toBe(
			'mark-done backfill --reason "..."',
		);
		expect(stepCommand("reset", "-old")).toBe("reset -- -old");
		expect(stepCommand("mark-done", "-old", ' --reason "..."')).toBe(
			'mark-done --reason "..." -- -old',
		);
	});
});
