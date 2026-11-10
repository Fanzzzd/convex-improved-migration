/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { expectNoneNeed } from "convex-improved-migration/test";
import { components, internal, api } from "./_generated/api";
import { initConvexTest } from "./setup.test";
import { migrations } from "./migrations";

const ROLE = "2026-11-10-user-role";
const GRANT = "2026-11-10-grant-admin-export";

async function addUsers(
	t: ReturnType<typeof initConvexTest>,
	count: number,
	role?: "member",
) {
	const names = Array.from({ length: count }, (_, i) => `user-${i}`);
	return await t.mutation(internal.users.addMany, { names, role });
}

function step<S extends { id: string }>(result: { steps: S[] }, id: string): S {
	const s = result.steps.find((x) => x.id === id);
	if (!s) throw new Error(`no step ${id}`);
	return s;
}

/**
 * Run the stepwise Plan's background driver one action at a time until the
 * run releases the Lease. `vi.runAllTimers` would jump the clock past Lease
 * expiry while the driver is still rescheduling itself.
 */
async function drainStepwise(t: ReturnType<typeof initConvexTest>) {
	for (let i = 0; i < 50; i++) {
		vi.advanceTimersByTime(1);
		await t.finishInProgressScheduledFunctions();
		if ((await t.query(internal.testing.stepwise.status, {})).run === null)
			return;
	}
	throw new Error("the stepwise run did not finish");
}

async function failure(p: Promise<unknown>): Promise<Error> {
	const e = await p.then(() => null).catch((err: Error) => err);
	if (!e) throw new Error("expected a failure");
	return e;
}

describe("apply", () => {
	test("a fresh deployment runs the whole Plan once and records via ran", async () => {
		const t = initConvexTest();
		const result = await t.action(internal.migrations.apply, {});
		expect(result.ok).toBe(true);
		expect(result.steps.map((s) => [s.id, s.state, s.via])).toEqual([
			["countries", "done", "ran"],
			[ROLE, "done", "ran"],
			[GRANT, "done", "ran"],
			["request-counters", "done", "ran"],
		]);
		const countries = await t.run((ctx) => ctx.db.query("countries").collect());
		expect(countries).toHaveLength(2);
		const status = await t.query(internal.migrations.status, {});
		expect(status.state).toBe("done");
		expect(status.next).toEqual([]);
	});

	test("backfills every document across batches, skips what does not need it, then verifies", async () => {
		const t = initConvexTest();
		await addUsers(t, 250);
		await addUsers(t, 30, "member");
		const result = await t.action(internal.migrations.apply, {});
		const s = step(result, ROLE);
		expect(s.processed).toBe(250);
		expect(s.skipped).toBe(30);
		expect(s.verified).toBe(true);
		expect(s.remaining).toBe(0);
		const users = await t.run((ctx) => ctx.db.query("users").collect());
		expect(users.every((u) => u.role === "member")).toBe(true);
		await expectNoneNeed(t, ROLE);
	});

	test("a second apply skips Done Migrations and runs Seeds again", async () => {
		const t = initConvexTest();
		await addUsers(t, 5);
		const first = await t.action(internal.migrations.apply, {});
		await addUsers(t, 3);
		const again = await t.action(internal.migrations.apply, {});
		expect(step(again, ROLE).processed).toBe(5);
		expect(step(again, "countries").state).toBe("done");
		expect(step(again, "countries").runId).toBe(again.runId);
		expect(step(again, ROLE).runId).toBe(first.runId);
		const users = await t.run((ctx) => ctx.db.query("users").collect());
		expect(users.filter((u) => u.role === undefined)).toHaveLength(3);
	});

	test("only runs the named Step", async () => {
		const t = initConvexTest();
		const result = await t.action(internal.migrations.apply, { only: GRANT });
		expect(result.steps.map((s) => s.id)).toEqual([GRANT]);
		const status = await t.query(internal.migrations.status, {});
		expect(step(status, "countries").state).toBe("pending");
		expect(status.state).toBe("pending");
	});
});

describe("failure", () => {
	test("a failing batch throws with the Step, batch, and next commands; later Steps do not run", async () => {
		const t = initConvexTest();
		await addUsers(t, 150);
		await t.mutation(internal.users.addMany, { names: ["poison"] });
		const error = await failure(t.action(internal.migrations.apply, {}));
		expect(error.message).toContain(
			`Step "${ROLE}" (migration) failed on batch 2`,
		);
		expect(error.message).toContain("cannot migrate user");
		expect(error.message).toContain(
			`Later Steps did not run: ${GRANT}, request-counters.`,
		);
		expect(error.message).toContain(
			`npx convex-improved-migration reset ${ROLE}`,
		);
		expect(error.message).toContain(
			`npx convex-improved-migration mark-done ${ROLE} --reason`,
		);
		const preview = await t.action(internal.migrations.apply, {
			dryRun: true,
			only: ROLE,
		});
		const reason = preview.steps[0]!.reason ?? "";
		expect(reason).toContain("dry-run batch threw: cannot migrate user");
		expect(reason).not.toMatch(/Uncaught|\n/);
		const status = await t.query(internal.migrations.status, {});
		expect(status.state).toBe("failed");
		expect(step(status, ROLE).state).toBe("failed");
		expect(step(status, ROLE).processed).toBe(100);
		expect(step(status, ROLE).error).toMatchObject({
			batch: 2,
			batchSize: 100,
			processed: 100,
		});
		expect(step(status, GRANT).state).toBe("pending");
		expect(status.next).toEqual([
			`npx convex-improved-migration status --events ${ROLE}`,
			"npx convex-improved-migration apply",
			`npx convex-improved-migration reset ${ROLE}`,
			`npx convex-improved-migration mark-done ${ROLE} --reason "..."`,
		]);
		await expect(
			t.query(internal.migrations.status, { check: true }),
		).rejects.toThrow(/Not every Step is done/);
	});

	test("apply again after the fix resumes from the saved cursor", async () => {
		const t = initConvexTest();
		await addUsers(t, 150);
		const [poison] = await t.mutation(internal.users.addMany, {
			names: ["poison"],
		});
		await t.action(internal.migrations.apply, {}).catch(() => {});
		await t.run((ctx) => ctx.db.patch("users", poison, { name: "fixed" }));
		const result = await t.action(internal.migrations.apply, {});
		expect(result.ok).toBe(true);
		expect(step(result, ROLE).processed).toBe(151);
	});

	test("limit errors halve the batch down to one document before failing", async () => {
		const t = initConvexTest();
		await t.mutation(internal.users.addMany, { names: ["limit-bomb"] });
		await t.action(internal.migrations.apply, {}).catch(() => {});
		const status = await t.query(internal.migrations.status, { events: ROLE });
		const shrinks = status.events!.filter((e) => e.type === "batch shrunk");
		expect(shrinks.map((e) => e.detail?.split(":")[0]).reverse()).toEqual([
			"100 -> 50",
			"50 -> 25",
			"25 -> 12",
			"12 -> 6",
			"6 -> 3",
			"3 -> 1",
		]);
		expect(step(status, ROLE).state).toBe("failed");
	});
});

describe("operate", () => {
	test("markDone needs a reason and records via marked", async () => {
		const t = initConvexTest();
		await expect(
			t.action(internal.migrations.operate, {
				op: "markDone",
				id: ROLE,
				reason: " ",
			}),
		).rejects.toThrow(/needs a reason/);
		const status = await t.action(internal.migrations.operate, {
			op: "markDone",
			id: ROLE,
			reason: "backfilled by hand",
		});
		const s = step(status, ROLE);
		expect(s.state).toBe("done");
		expect(s.via).toBe("marked");
		expect(s.reason).toContain("backfilled by hand");
		await addUsers(t, 3);
		const result = await t.action(internal.migrations.apply, {});
		expect(step(result, ROLE).processed).toBe(0);
	});

	test("markDone refuses a Step that is already done and keeps its record", async () => {
		const t = initConvexTest();
		await addUsers(t, 3);
		await t.action(internal.migrations.apply, {});
		await expect(
			t.action(internal.migrations.operate, {
				op: "markDone",
				id: ROLE,
				reason: "by hand",
			}),
		).rejects.toThrow(
			/^"2026-11-10-user-role" is already done \(done via ran on .+\)\. Nothing changed\./,
		);
		const s = step(await t.query(internal.migrations.status, {}), ROLE);
		expect(s).toMatchObject({ via: "ran", processed: 3 });
	});

	test("reset restarts only that Step", async () => {
		const t = initConvexTest();
		await addUsers(t, 2);
		await t.action(internal.migrations.apply, {});
		const status = await t.action(internal.migrations.operate, {
			op: "reset",
			id: ROLE,
		});
		expect(step(status, ROLE).state).toBe("pending");
		expect(step(status, ROLE).processed).toBe(0);
		expect(step(status, GRANT).state).toBe("done");
	});

	test("unknown ids list the known ones", async () => {
		const t = initConvexTest();
		await expect(
			t.action(internal.migrations.operate, {
				op: "reset",
				id: "nope" as typeof ROLE,
			}),
		).rejects.toThrow(/Known: countries, 2026-11-10-user-role/);
	});

	test("dry run writes nothing and reports the first batch's writes to every table", async () => {
		const t = initConvexTest();
		await addUsers(t, 3);
		const userIds = await t.run(async (ctx) =>
			(await ctx.db.query("users").collect()).map((u) => u._id),
		);
		await t.run((ctx) =>
			ctx.db.insert("requests", { userId: userIds[0], amount: 1 }),
		);
		const preview = await t.action(internal.migrations.apply, { dryRun: true });
		expect(preview.dryRun).toBe(true);
		const role = step(preview, ROLE);
		expect(role.wouldRun).toBe(true);
		expect(role.reason).toBe("never ran");
		expect(role.changes).toHaveLength(3);
		expect(role.changes![0]).toMatchObject({
			table: "users",
			op: "patch",
			value: { role: "member" },
		});
		expect(step(preview, "request-counters").changes).toEqual([
			expect.objectContaining({ table: "requestCounters", op: "insert" }),
		]);
		const users = await t.run((ctx) => ctx.db.query("users").collect());
		expect(users.every((u) => u.role === undefined)).toBe(true);
		const status = await t.query(internal.migrations.status, {});
		expect(status.steps.every((s) => s.state === "pending")).toBe(true);
	});
});

describe("readiness", () => {
	test("expectNoneNeed names a Step without a needs predicate", async () => {
		const t = initConvexTest();
		await expect(expectNoneNeed(t, "countries")).rejects.toThrow(
			'Step "countries" has no needs predicate, so there is nothing to verify.',
		);
	});

	test("the demo adds users with a role once the role Migration is Done", async () => {
		const t = initConvexTest();
		const roles = async () =>
			(await t.query(api.demo.overview, {})).users.map((u) => u.stored);
		await t.mutation(api.demo.addUsers, { count: 2 });
		expect(await roles()).toEqual([null, null]);
		await t.action(internal.migrations.apply, {});
		await t.mutation(api.demo.addUsers, { count: 2 });
		expect((await roles()).slice(0, 2)).toEqual(["member", "member"]);
		await expectNoneNeed(t, ROLE);
	});

	test("isReady flips when the Migration is Done", async () => {
		const t = initConvexTest();
		const [id] = await addUsers(t, 1);
		expect(await t.query(api.users.roleOf, { id })).toBe("member");
		await t.run(async (ctx) => {
			expect(await migrations.isReady(ctx, ROLE)).toBe(false);
		});
		await t.action(internal.migrations.apply, {});
		await t.run(async (ctx) => {
			expect(await migrations.isReady(ctx, ROLE)).toBe(true);
			expect(await migrations.isReady(ctx, "countries")).toBe(true);
		});
	});

	test("Batches write progress, not the steps row Readiness reads", async () => {
		vi.useFakeTimers();
		try {
			const t = initConvexTest();
			await addUsers(t, 30);
			await t.action(internal.testing.stepwise.apply, { wait: false });
			const read = () =>
				t.query(internal.testing.stepwise.status, { events: "stepwise-role" });
			// First unit: the Step starts and runs Batch 1.
			vi.advanceTimersByTime(1);
			await t.finishInProgressScheduledFunctions();
			const before = await read();
			vi.advanceTimersByTime(1);
			await t.finishInProgressScheduledFunctions();
			const after = await read();
			expect(before.steps[0].processed).toBe(10);
			expect(after.steps[0].processed).toBe(20);
			expect(after.steps[0].state).toBe("running");
			// Batch 2 added no Event: the steps row only changes on transitions.
			expect(after.events!.length).toBe(before.events!.length);
			await drainStepwise(t);
		} finally {
			vi.useRealTimers();
		}
	});

	test("migrations.step exposes the definition for unit tests", () => {
		const def = migrations.step(ROLE).definition;
		expect(def.table).toBe("users");
		expect(migrations.ids).toEqual([
			"countries",
			ROLE,
			GRANT,
			"request-counters",
		]);
	});
});

describe("rebuild", () => {
	test("apply with rebuild all clears and recomputes derived data", async () => {
		const t = initConvexTest();
		const [a, b] = await addUsers(t, 2);
		await t.run(async (ctx) => {
			await ctx.db.insert("requests", { userId: a, amount: 1 });
			await ctx.db.insert("requests", { userId: a, amount: 2 });
			await ctx.db.insert("requests", { userId: b, amount: 3 });
		});
		await t.action(internal.migrations.apply, {});
		const counts = () =>
			t.run(async (ctx) =>
				(await ctx.db.query("requestCounters").collect())
					.map((c) => c.count)
					.sort(),
			);
		expect(await counts()).toEqual([1, 2]);
		// Simulate an import that brought requests without their counters.
		await t.run(async (ctx) => {
			for (const c of await ctx.db.query("requestCounters").collect()) {
				await ctx.db.patch("requestCounters", c._id, { count: 99 });
			}
		});
		const result = await t.action(internal.migrations.apply, {
			rebuild: "all",
		});
		expect(step(result, "request-counters").state).toBe("done");
		expect(step(result, "request-counters").runId).toBe(result.runId);
		expect(step(result, ROLE).runId).not.toBe(result.runId);
		expect(await counts()).toEqual([1, 2]);
	});

	test("rebuild refuses non-rebuild Steps", async () => {
		const t = initConvexTest();
		await expect(
			t.action(internal.migrations.apply, { rebuild: [ROLE] }),
		).rejects.toThrow(/is a migration, not a rebuild/);
	});
});

describe("orphans and adoption", () => {
	test("an unfinished Step removed from the Plan blocks apply until marked done", async () => {
		const t = initConvexTest();
		await t.action(internal.testing.altPlan.apply, {}).catch(() => {});
		const error = await failure(t.action(internal.migrations.apply, {}));
		expect(error.message).toMatch(
			/"removed-before-finishing" \(failed\) was removed from the Plan/,
		);
		expect(error.message).toContain("mark-done removed-before-finishing");
		const status = await t.action(internal.migrations.operate, {
			op: "markDone",
			id: "removed-before-finishing",
			reason: "code deleted",
		});
		expect(status.orphans).toEqual([
			{ id: "removed-before-finishing", state: "done", via: "marked" },
		]);
		expect((await t.action(internal.migrations.apply, {})).ok).toBe(true);
	});

	test("adoption checks the expected count, records via adopted, and is idempotent", async () => {
		const t = initConvexTest();
		await expect(
			t.mutation(internal.testing.fakeUpstream.adopt, { expectCount: 3 }),
		).rejects.toThrow(/expected 3 done migrations upstream but found 2/);
		expect(
			await t.mutation(internal.testing.fakeUpstream.adopt, { expectCount: 2 }),
		).toEqual({ adopted: 2, alreadyDone: 0 });
		expect(
			await t.mutation(internal.testing.fakeUpstream.adopt, { expectCount: 2 }),
		).toEqual({ adopted: 0, alreadyDone: 2 });
		const status = await t.query(internal.migrations.status, {});
		expect(status.orphans.map((o) => o.id).sort()).toEqual([
			"migrations:oldBackfillA",
			"migrations:oldBackfillB",
		]);
	});
});

describe("background", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("apply with wait false runs the Plan in the background", async () => {
		const t = initConvexTest();
		await addUsers(t, 120);
		const started = await t.action(internal.migrations.apply, { wait: false });
		expect(started.started).toBe(true);
		expect((await t.query(internal.migrations.status, {})).state).toBe(
			"running",
		);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const status = await t.query(internal.migrations.status, { check: true });
		expect(status.state).toBe("done");
		expect(status.run).toBeNull();
	});

	test("migrations.start schedules a run from a mutation", async () => {
		const t = initConvexTest();
		await addUsers(t, 3);
		const { runId } = await t.run((ctx) => migrations.start(ctx));
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const status = await t.query(internal.migrations.status, {});
		expect(status.state).toBe("done");
		expect(step(status, ROLE).runId).toBe(runId);
	});

	test("cancel stops at the next batch boundary and apply resumes from the cursor", async () => {
		const t = initConvexTest();
		await addUsers(t, 35);
		await t.action(internal.testing.stepwise.apply, { wait: false });
		for (let i = 0; i < 2; i++) {
			vi.advanceTimersByTime(1);
			await t.finishInProgressScheduledFunctions();
		}
		const canceled = await t.action(internal.testing.stepwise.operate, {
			op: "cancel",
		});
		const s = canceled.steps[0];
		expect(s.state).toBe("pending");
		expect(s.reason).toBe("canceled; apply resumes it");
		expect(s.processed).toBe(20);
		await drainStepwise(t);
		expect(
			(await t.query(internal.testing.stepwise.status, {})).steps[0].processed,
		).toBe(20);
		const result = await t.action(internal.testing.stepwise.apply, {
			wait: false,
		});
		await drainStepwise(t);
		const done = await t.query(internal.testing.stepwise.status, {});
		expect(done.steps[0].processed).toBe(35);
		expect(done.steps[0].state).toBe("done");
		expect(done.steps[0].runId).toBe(result.runId);
	});

	test("a foreground apply past its budget hands the run to the background", async () => {
		const t = initConvexTest();
		await addUsers(t, 25);
		const error = await failure(t.action(internal.testing.stepwise.apply, {}));
		expect(error.message).toMatch(/Still running/);
		expect(error.message).toContain("status --module testing/stepwise");
		await drainStepwise(t);
		const status = await t.query(internal.testing.stepwise.status, {});
		expect(status.state).toBe("done");
		expect(status.steps[0].processed).toBe(25);
	});
});

describe("a run longer than one apply call", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		delete (globalThis as { advanceTestClock?: () => void }).advanceTestClock;
	});

	const seedRuns = (t: ReturnType<typeof initConvexTest>) =>
		t.run(
			async (ctx) =>
				(await ctx.db.query("grants").collect()).filter(
					(g) => g.role === "laps-seed-run",
				).length,
		);

	/** The first apply of the laps Plan: one unit of work, then Still Running. */
	async function firstLap(t: ReturnType<typeof initConvexTest>) {
		const error = await failure(t.action(internal.testing.laps.apply, {}));
		const match = /^Still running: run (\S+) continues in the background/.exec(
			error.message,
		);
		if (!match) throw new Error(`not a Still Running error: ${error.message}`);
		return { runId: match[1], message: error.message };
	}

	async function drainLaps(t: ReturnType<typeof initConvexTest>) {
		for (let i = 0; i < 50; i++) {
			vi.advanceTimersByTime(1);
			await t.finishInProgressScheduledFunctions();
			if ((await t.query(internal.testing.laps.status, {})).run === null)
				return;
		}
		throw new Error("the laps run did not finish");
	}

	test("a foreground apply hands over after 4 minutes by default, not after the 20-minute driver budget", async () => {
		const t = initConvexTest();
		await addUsers(t, 3);
		let moved = false;
		(globalThis as { advanceTestClock?: () => void }).advanceTestClock = () => {
			if (!moved) vi.setSystemTime(Date.now() + 241_000);
			moved = true;
		};
		const error = await failure(
			t.action(internal.testing.regressions.apply, { only: "slow-clock" }),
		);
		expect(error.message).toMatch(
			/^Still running: run \S+ continues in the background after 241s\./,
		);
	});

	test("a foreground apply that stays under 4 minutes finishes by itself", async () => {
		const t = initConvexTest();
		await addUsers(t, 3);
		let moved = false;
		(globalThis as { advanceTestClock?: () => void }).advanceTestClock = () => {
			if (!moved) vi.setSystemTime(Date.now() + 239_000);
			moved = true;
		};
		const result = await t.action(internal.testing.regressions.apply, {
			only: "slow-clock",
		});
		expect(result.steps[0].state).toBe("done");
	});

	test("apply with resume goes on with the same run, and its Seeds run once", async () => {
		const t = initConvexTest();
		await addUsers(t, 25);
		const { runId, message } = await firstLap(t);
		expect(message).toContain(
			`Keep waiting with: npx convex run testing/laps:apply '{"resume":"${runId}"}'.`,
		);
		let result;
		let laps = 1;
		while (!result) {
			if (++laps > 20) throw new Error("too many laps");
			try {
				result = await t.action(internal.testing.laps.apply, { resume: runId });
			} catch (e) {
				expect((e as Error).message).toMatch(
					new RegExp(`^Still running: run ${runId} continues`),
				);
			}
		}
		expect(laps).toBeGreaterThan(2);
		expect(result.runId).toBe(runId);
		expect(result.steps.map((s) => [s.state, s.runId])).toEqual([
			["done", runId],
			["done", runId],
		]);
		expect(step(result, "laps-role").processed).toBe(25);
		expect(await seedRuns(t)).toBe(1);
		expect((await t.query(internal.testing.laps.status, {})).run).toBeNull();
		const events = await t.query(internal.testing.laps.status, {
			events: "(run)",
		});
		expect(events.events!.some((e) => e.type === "taken back")).toBe(true);
	});

	test("a plain apply after Still Running starts a new run, which runs the Seeds again", async () => {
		const t = initConvexTest();
		await addUsers(t, 5);
		const { runId } = await firstLap(t);
		const second = await failure(t.action(internal.testing.laps.apply, {}));
		expect(second.message).toMatch(/^Still running: run \S+ continues/);
		expect(second.message).not.toContain(runId);
		expect(await seedRuns(t)).toBe(2);
	});

	test("resume after the run finished in the background reports success without a new run", async () => {
		const t = initConvexTest();
		await addUsers(t, 25);
		const { runId } = await firstLap(t);
		await drainLaps(t);
		const result = await t.action(internal.testing.laps.apply, {
			resume: runId,
		});
		expect(result).toMatchObject({ ok: true, runId });
		expect(result.steps.every((s) => s.state === "done")).toBe(true);
		expect(await seedRuns(t)).toBe(1);
	});

	test("resume after the run failed in the background throws the Step's failure", async () => {
		const t = initConvexTest();
		await addUsers(t, 12);
		await t.mutation(internal.users.addMany, { names: ["poison"] });
		const { runId } = await firstLap(t);
		await drainLaps(t);
		const error = await failure(
			t.action(internal.testing.laps.apply, { resume: runId }),
		);
		expect(error.message).toContain(
			'Step "laps-role" (migration) failed on batch 2 after 10 document(s)',
		);
		expect(error.message).toContain("cannot migrate user");
		expect(await seedRuns(t)).toBe(1);
	});

	test("resume after another apply took over names the other run", async () => {
		const t = initConvexTest();
		await addUsers(t, 25);
		const { runId } = await firstLap(t);
		const other = await t.action(internal.testing.laps.apply, { wait: false });
		const error = await failure(
			t.action(internal.testing.laps.apply, { resume: runId }),
		);
		expect(error.message).toBe(
			`Another apply (run ${other.runId}) took over run ${runId}. Check with npx convex-improved-migration status --module testing/laps.`,
		);
	});

	test("resume after the run lost its Lease says the run ended before the Plan finished", async () => {
		const t = initConvexTest();
		await addUsers(t, 25);
		const { runId } = await firstLap(t);
		// What the watchdog does when it gives up on a run: drop its Lease.
		const { lease } = await t.query(components.migration.lib.status, {});
		await t.mutation(components.migration.lib.release, {
			holder: lease!.holder,
			runId,
		});
		const error = await failure(
			t.action(internal.testing.laps.apply, { resume: runId }),
		);
		expect(error.message).toContain(
			`Run ${runId} ended before the Plan finished; the Plan is pending.`,
		);
	});

	test("resume cannot be combined with rebuild or wait: false", async () => {
		const t = initConvexTest();
		for (const extra of [{ rebuild: "all" as const }, { wait: false }]) {
			await expect(
				t.action(internal.testing.laps.apply, { resume: "abc", ...extra }),
			).rejects.toThrow(/Do not combine it with rebuild or wait: false/);
		}
	});
});

describe("arguments that do not fit are refused", () => {
	test("dryRun with rebuild, wait or resume", async () => {
		const t = initConvexTest();
		for (const extra of [
			{ rebuild: "all" as const },
			{ wait: false },
			{ resume: "abc" },
		]) {
			await expect(
				t.action(internal.migrations.apply, { dryRun: true, ...extra }),
			).rejects.toThrow(/dryRun only takes `only`/);
		}
		expect((await t.query(internal.migrations.status, {})).run).toBeNull();
	});

	test("operate cancel with an id, and reset or cancel with a reason", async () => {
		const t = initConvexTest();
		const operate = (args: object) =>
			t.action(internal.migrations.operate, args as never);
		await expect(operate({ op: "cancel", id: ROLE })).rejects.toThrow(
			/operate cancel takes no id/,
		);
		await expect(operate({ op: "cancel", reason: "x" })).rejects.toThrow(
			/operate cancel takes no reason/,
		);
		await expect(
			operate({ op: "reset", id: ROLE, reason: "x" }),
		).rejects.toThrow(/operate reset takes no reason/);
	});
});

describe("regressions", () => {
	test("after a failed verify pass, apply rescans and can pass", async () => {
		const t = initConvexTest();
		await addUsers(t, 3);
		const first = await failure(
			t.action(internal.testing.regressions.apply, { only: "verify-me" }),
		);
		expect(first.message).toContain("failed during verification");
		expect(first.message).toContain("Verification found 3 document(s)");
		// status keeps the count the verify pass found.
		const failed = await t.query(internal.testing.regressions.status, {});
		expect(step(failed, "verify-me")).toMatchObject({
			state: "failed",
			remaining: 3,
		});
		// The fix lands: run now writes the role.
		await t.run((ctx) =>
			ctx.db.insert("grants", { role: "x", permission: "y" }),
		);
		const second = await t.action(internal.testing.regressions.apply, {
			only: "verify-me",
		});
		expect(second.steps[0]).toMatchObject({
			state: "done",
			verified: true,
			remaining: 0,
		});
		const users = await t.run((ctx) => ctx.db.query("users").collect());
		expect(users.map((u) => u.role)).toEqual(["member", "member", "member"]);
	});

	test("a Seed with a limit-looking error fails instead of looping", async () => {
		const t = initConvexTest();
		const error = await failure(
			t.action(internal.testing.regressions.apply, { only: "limit-seed" }),
		);
		expect(error.message).toContain(`Step "limit-seed" (seed) failed.\n`);
		// One call: no Batch, cursor or count.
		expect(error.message).toContain(
			"Next: fix the cause, then npx convex-improved-migration apply --module testing/regressions runs it again.",
		);
		expect(error.message).not.toMatch(/batch|cursor|reset limit-seed/);
		const status = await t.query(internal.testing.regressions.status, {
			events: "limit-seed",
		});
		const seed = status.steps.find((s) => s.id === "limit-seed")!;
		expect(seed.table).toBe(false);
		expect(status.steps.find((s) => s.id === "verify-me")!.table).toBe(true);
		const preview = await t.action(internal.testing.regressions.apply, {
			dryRun: true,
			only: "limit-seed",
		});
		expect(preview.steps[0]!.reason).toBe("failed; apply runs it again");
		expect(status.events!.filter((e) => e.type === "started")).toHaveLength(1);
		expect(
			status.events!.filter((e) => e.type === "batch shrunk"),
		).toHaveLength(0);
	});

	test("user errors that mention a limit fail without halving the Batch", async () => {
		const t = initConvexTest();
		await addUsers(t, 3);
		for (const id of ["user-limit-error", "user-convex-error"] as const) {
			await failure(t.action(internal.testing.regressions.apply, { only: id }));
			const status = await t.query(internal.testing.regressions.status, {
				events: id,
			});
			expect(
				status.events!.filter((e) => e.type === "batch shrunk"),
			).toHaveLength(0);
			expect(step(status, id).error).toMatchObject({
				batch: 1,
				batchSize: 100,
			});
		}
	});

	test("isReady is false for a Rebuild built for an older Version, true for a Seed that re-runs", async () => {
		const t = initConvexTest();
		await t.action(internal.migrations.apply, {});
		const { rebuildV2 } = await import("./testing/rebuildV2");
		await t.run(async (ctx) => {
			expect(await migrations.isReady(ctx, "request-counters")).toBe(true);
			expect(await rebuildV2.isReady(ctx, "request-counters")).toBe(false);
		});
		// A Seed stays Ready while later applies run it again.
		await t.action(internal.migrations.apply, {});
		await t.run(async (ctx) => {
			expect(await migrations.isReady(ctx, "countries")).toBe(true);
		});
	});

	test("a bad only or rebuild id is refused before the Lease is taken", async () => {
		const t = initConvexTest();
		await expect(
			t.action(internal.migrations.apply, { only: "nope" as typeof ROLE }),
		).rejects.toThrow(/No Step "nope"/);
		await expect(
			t.action(internal.migrations.apply, { rebuild: ["nope" as typeof ROLE] }),
		).rejects.toThrow(/No Step "nope"/);
		expect((await t.query(internal.migrations.status, {})).run).toBeNull();
		expect((await t.action(internal.migrations.apply, {})).ok).toBe(true);
	});

	test("dry run shows removed fields as <unset>", async () => {
		const t = initConvexTest();
		await addUsers(t, 1, "member");
		const preview = await t.action(internal.testing.regressions.apply, {
			dryRun: true,
			only: "unset-role",
		});
		expect(preview.steps[0].changes).toEqual([
			expect.objectContaining({
				table: "users",
				op: "patch",
				value: { role: "<unset>" },
			}),
		]);
	});
	test("dry run previews the next Batch from the saved cursor", async () => {
		const t = initConvexTest();
		const ids = await addUsers(t, 150);
		const [poison] = await t.mutation(internal.users.addMany, {
			names: ["poison"],
		});
		await t.action(internal.migrations.apply, {}).catch(() => {});
		await t.run((ctx) => ctx.db.patch("users", poison, { name: "fixed" }));
		const preview = await t.action(internal.migrations.apply, {
			dryRun: true,
			only: ROLE,
		});
		const role = step(preview, ROLE);
		expect(role.reason).toBe(
			"failed; apply resumes from the saved cursor; preview of batch 2, from the saved cursor",
		);
		// Batch 1 migrated users 0 to 99. The preview starts at user 100 and
		// shows the first 20 writes.
		expect(role.changes!.map((c) => c.id)).toEqual(ids.slice(100, 120));
		expect(
			step(await t.query(internal.migrations.status, {}), ROLE).processed,
		).toBe(100);
	});

	test("dry run stops previewing Batches at its time budget and says so", async () => {
		vi.useFakeTimers();
		try {
			const t = initConvexTest();
			await addUsers(t, 1);
			(globalThis as { advanceTestClock?: () => void }).advanceTestClock = () =>
				vi.setSystemTime(Date.now() + 241_000);
			const preview = await t.action(internal.testing.regressions.apply, {
				dryRun: true,
			});
			expect(step(preview, "unset-role").changes).toHaveLength(1);
			for (const id of ["run-paginates", "clear-paginates"] as const) {
				expect(step(preview, id).wouldRun).toBe(true);
				expect(step(preview, id).changes).toBeUndefined();
				expect(step(preview, id).reason).toContain(
					"no batch preview, because the dry run reached its time budget",
				);
			}
		} finally {
			delete (globalThis as { advanceTestClock?: () => void }).advanceTestClock;
			vi.useRealTimers();
		}
	});

	test("dry run of a Rebuild runs its clear before the Batch", async () => {
		const t = initConvexTest();
		const [a] = await addUsers(t, 1);
		await t.run((ctx) => ctx.db.insert("requests", { userId: a, amount: 1 }));
		await t.action(internal.migrations.apply, {});
		await t.action(internal.migrations.operate, {
			op: "reset",
			id: "request-counters",
		});
		const preview = await t.action(internal.migrations.apply, {
			dryRun: true,
			only: "request-counters",
		});
		const counters = step(preview, "request-counters");
		// Without the clear the Batch would patch the existing counter to 2.
		expect(counters.changes!.map((c) => `${c.op} ${c.table}`)).toEqual([
			"delete requestCounters",
			"insert requestCounters",
		]);
		expect(counters.changes![1].value).toMatchObject({ count: 1 });
		expect(counters.reason).toContain("preview includes the clear");
		const rows = await t.run((ctx) =>
			ctx.db.query("requestCounters").collect(),
		);
		expect(rows.map((r) => r.count)).toEqual([1]);
	});

	test("cancel with a run id leaves a newer run alone", async () => {
		vi.useFakeTimers();
		try {
			const t = initConvexTest();
			await addUsers(t, 10);
			const { runId } = await t.action(internal.testing.stepwise.apply, {
				wait: false,
			});
			const error = await failure(
				t.action(internal.testing.stepwise.operate, {
					op: "cancel",
					runId: "an-older-run",
				}),
			);
			expect(error.message).toContain(
				`Run an-older-run is no longer running; run ${runId} started since. Nothing was canceled.`,
			);
			const s = await t.query(internal.testing.stepwise.status, {});
			expect(s.run).toMatchObject({ id: runId, live: true });
			await t.action(internal.testing.stepwise.operate, {
				op: "cancel",
				runId: runId!,
			});
			expect(
				(await t.query(internal.testing.stepwise.status, {})).state,
			).not.toBe("running");
			await expect(
				// A caller without the types can send it.
				t.action(internal.testing.stepwise.operate, {
					op: "reset",
					id: "stepwise-role",
					runId: runId!,
				} as never),
			).rejects.toThrow("operate reset takes no runId.");
			await drainStepwise(t);
		} finally {
			vi.useRealTimers();
		}
	});

	test("dry run of a Step that only has its verify pass left shows no writes", async () => {
		vi.useFakeTimers();
		try {
			const t = initConvexTest();
			await addUsers(t, 10);
			await t.action(internal.testing.stepwise.apply, { wait: false });
			const phase = async () =>
				(await t.query(internal.testing.stepwise.status, {})).steps[0].phase;
			for (let i = 0; i < 10 && (await phase()) !== "verify"; i++) {
				vi.advanceTimersByTime(1);
				await t.finishInProgressScheduledFunctions();
			}
			expect(await phase()).toBe("verify");
			await t.action(internal.testing.stepwise.operate, { op: "cancel" });
			await drainStepwise(t);
			// A user added now would be patched by a preview of the first Batch.
			await t.mutation(internal.users.addMany, { names: ["late"] });
			const preview = await t.action(internal.testing.stepwise.apply, {
				dryRun: true,
			});
			expect(preview.steps[0]).toMatchObject({
				wouldRun: true,
				phase: "verify",
				changes: [],
			});
			expect(preview.steps[0].reason).toBe(
				"canceled; apply resumes it; only the verify pass is left, which writes nothing",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	test("after a failed verify pass the dry run previews the rescan from the start", async () => {
		const t = initConvexTest();
		await addUsers(t, 3);
		await t
			.action(internal.testing.regressions.apply, { only: "verify-me" })
			.catch(() => {});
		await t.run((ctx) =>
			ctx.db.insert("grants", { role: "admin", permission: "export" }),
		);
		const preview = await t.action(internal.testing.regressions.apply, {
			dryRun: true,
			only: "verify-me",
		});
		expect(preview.steps[0].changes).toHaveLength(3);
		expect(preview.steps[0].reason).toBe(
			"failed; apply resumes from the saved cursor",
		);
	});

	test("after apply, no import is suspected and the Rebuild is ready", async () => {
		// Real timers: convex-test fires the sentinel at once. Fake timers: it
		// stays pending, as on a deployment. Neither reads as an import.
		for (const fake of [false, true]) {
			if (fake) vi.useFakeTimers();
			try {
				const t = initConvexTest();
				await addUsers(t, 1);
				await t.action(internal.migrations.apply, {});
				if (!fake) await new Promise((resolve) => setTimeout(resolve, 20));
				const status = await t.query(internal.migrations.status, {
					check: true,
				});
				expect(status.importSuspected).toBe(false);
				expect(step(status, "request-counters").state).toBe("done");
				expect(
					await t.run((ctx) => migrations.isReady(ctx, "request-counters")),
				).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		}
	});

	test("convex-test refuses .paginate() in run, and the error says why", async () => {
		const t = initConvexTest();
		await addUsers(t, 1);
		const error = await failure(
			t.action(internal.testing.regressions.apply, { only: "run-paginates" }),
		);
		expect(error.message).toContain(
			'Hint: "run-paginates" calls .paginate() in run. Each Batch already runs one paginated query. ' +
				"This runtime allows one per function. Use .take() or .collect().",
		);
	});

	test("a clear function may paginate once; the Dry Run then previews the Batch alone", async () => {
		const t = initConvexTest();
		const [a] = await addUsers(t, 1);
		await t.run(async (ctx) => {
			await ctx.db.insert("requests", { userId: a, amount: 1 });
			await ctx.db.insert("requestCounters", { userId: a, count: 99 });
		});
		const preview = await t.action(internal.testing.regressions.apply, {
			dryRun: true,
			only: "clear-paginates",
		});
		expect(preview.steps[0].changes!.map((c) => c.op)).toEqual(["insert"]);
		expect(preview.steps[0].reason).toContain(
			"preview does not include the clear, because clear calls .paginate()",
		);
		expect(preview.orphans).toEqual([]);
		const result = await t.action(internal.testing.regressions.apply, {
			only: "clear-paginates",
		});
		expect(result.ok).toBe(true);
		const rows = await t.run((ctx) =>
			ctx.db.query("requestCounters").collect(),
		);
		expect(rows.map((r) => r.count)).toEqual([1]);
	});

	test("reset keeps what the Step had achieved in the Event log", async () => {
		const t = initConvexTest();
		await addUsers(t, 7);
		await addUsers(t, 2, "member");
		await t.action(internal.migrations.apply, {});
		await t.action(internal.migrations.operate, { op: "reset", id: ROLE });
		const status = await t.query(internal.migrations.status, { events: ROLE });
		expect(status.events![0].type).toBe("reset");
		expect(status.events![0].detail).toMatch(
			/^was done via ran at \d{4}-\d\d-\d\dT[\d:.]+Z, processed 7, skipped 2$/,
		);
	});

	test("a Rebuild that starts over records what the previous build achieved", async () => {
		const t = initConvexTest();
		const [a] = await addUsers(t, 1);
		await t.run((ctx) => ctx.db.insert("requests", { userId: a, amount: 1 }));
		await t.action(internal.migrations.apply, {});
		await t.action(internal.migrations.apply, { rebuild: "all" });
		const status = await t.query(internal.migrations.status, {
			events: "request-counters",
		});
		const started = status.events!.filter((e) => e.type === "started");
		expect(started[0].detail).toMatch(
			/^rebuild requested; was done via ran at .+Z, version 1, processed 1, skipped 0$/,
		);
	});

	test("reset and markDone refuse a Step that a live run is working on", async () => {
		vi.useFakeTimers();
		try {
			const t = initConvexTest();
			await addUsers(t, 35);
			await t.action(internal.testing.stepwise.apply, { wait: false });
			vi.advanceTimersByTime(1);
			await t.finishInProgressScheduledFunctions();
			for (const args of [
				{ op: "reset", id: "stepwise-role" },
				{ op: "markDone", id: "stepwise-role", reason: "by hand" },
			] as const) {
				const error = await failure(
					t.action(internal.testing.stepwise.operate, args),
				);
				expect(error.message).toContain(
					`Refusing to ${args.op === "markDone" ? "mark-done" : args.op} "stepwise-role"`,
				);
				expect(error.message).toContain(
					"npx convex-improved-migration cancel --module testing/stepwise",
				);
			}
			// After cancel the Step is pending, and both are allowed.
			await t.action(internal.testing.stepwise.operate, { op: "cancel" });
			await drainStepwise(t);
			const reset = await t.action(internal.testing.stepwise.operate, {
				op: "reset",
				id: "stepwise-role",
			});
			expect(reset.steps[0]).toMatchObject({ state: "pending", processed: 0 });
			const marked = await t.action(internal.testing.stepwise.operate, {
				op: "markDone",
				id: "stepwise-role",
				reason: "by hand",
			});
			expect(marked.steps[0]).toMatchObject({ state: "done", via: "marked" });
		} finally {
			vi.useRealTimers();
		}
	});

	test("reset is allowed on a failed Step", async () => {
		const t = initConvexTest();
		await t.mutation(internal.users.addMany, { names: ["poison"] });
		await t.action(internal.migrations.apply, {}).catch(() => {});
		const status = await t.action(internal.migrations.operate, {
			op: "reset",
			id: ROLE,
		});
		expect(step(status, ROLE).state).toBe("pending");
	});
});

describe("how a run ended, and its scope", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const R = internal.testing.rebuildLaps;

	async function seedData(
		t: ReturnType<typeof initConvexTest>,
		{ requests = 0, counters = 0, amount = 1 },
	) {
		await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { name: "ada" });
			for (let i = 0; i < requests; i++)
				await ctx.db.insert("requests", { userId, amount });
			for (let i = 0; i < counters; i++)
				await ctx.db.insert("requestCounters", { userId, count: 1 });
		});
	}

	/** The first apply: one unit of work, then Still Running. */
	async function firstLap(
		t: ReturnType<typeof initConvexTest>,
		args: { only?: "laps-counters" | "laps-member" } = {},
	) {
		const error = await failure(t.action(R.apply, args));
		const match = /^Still running: run (\S+) /.exec(error.message);
		if (!match) throw new Error(`not a Still Running error: ${error.message}`);
		return match[1];
	}

	async function drain(t: ReturnType<typeof initConvexTest>) {
		for (let i = 0; i < 50; i++) {
			vi.advanceTimersByTime(1);
			await t.finishInProgressScheduledFunctions();
			if ((await t.query(R.status, {})).run === null) return;
		}
		throw new Error("the run did not finish");
	}

	test("resume refuses another scope than the run's and names the run's scope", async () => {
		const t = initConvexTest();
		await seedData(t, { requests: 5, counters: 25 });
		const runId = await firstLap(t, { only: "laps-counters" });
		for (const only of [undefined, "laps-member" as const]) {
			const error = await failure(
				t.action(R.apply, { resume: runId, ...(only ? { only } : {}) }),
			);
			expect(error.message).toBe(
				`Run ${runId} was started with only "laps-counters". Resume it with: npx convex run testing/rebuildLaps:apply '{"resume":"${runId}","only":"laps-counters"}'`,
			);
		}
		// The refusal did not take the run away from its background driver.
		expect((await t.query(R.status, {})).run?.mode).toBe("background");

		await drain(t);
		const whole = await firstLap(t);
		const error = await failure(
			t.action(R.apply, { resume: whole, only: "laps-member" }),
		);
		expect(error.message).toBe(
			`Run ${whole} covers the whole Plan. Resume it with: npx convex run testing/rebuildLaps:apply '{"resume":"${whole}"}'`,
		);
	});

	test("a run canceled between two laps says Canceled when resumed, and status says canceled", async () => {
		const t = initConvexTest();
		await seedData(t, { requests: 5, counters: 25 });
		const runId = await firstLap(t);
		const canceled = await t.action(R.operate, { op: "cancel" });
		// Stopped in the clear, before any Batch.
		expect(step(canceled, "laps-counters")).toMatchObject({
			state: "pending",
			phase: "clear",
			reason: "canceled; apply resumes it",
		});
		const early = await failure(t.action(R.apply, { resume: runId }));
		expect(early.message).toMatch(
			/^Canceled\. The interrupted Step keeps its cursor/,
		);
		// The driver stops at its next unit and drops the Lease.
		await drain(t);
		const late = await failure(t.action(R.apply, { resume: runId }));
		expect(late.message).toMatch(
			/^Canceled\. The interrupted Step keeps its cursor/,
		);
	});

	test("a failed Rebuild stays failed in status after a rebuild is requested for it", async () => {
		const t = initConvexTest();
		await seedData(t, { requests: 3, amount: -1 });
		await t.action(R.apply, { wait: false, only: "laps-counters" });
		await drain(t);
		expect(step(await t.query(R.status, {}), "laps-counters").state).toBe(
			"failed",
		);
		await t.action(R.apply, {
			wait: false,
			only: "laps-member",
			rebuild: ["laps-counters"],
		});
		await drain(t);
		const status = await t.query(R.status, {});
		expect(status.state).toBe("failed");
		expect(step(status, "laps-counters")).toMatchObject({
			state: "failed",
			reason: "rebuild requested; apply starts it over",
		});
		expect(step(status, "laps-counters").error?.message).toContain(
			"negative amount",
		);
	});

	test("mark-done and reset clear the run id of the run before", async () => {
		vi.useRealTimers();
		const t = initConvexTest();
		await addUsers(t, 2);
		const first = await t.action(internal.migrations.apply, {});
		expect(step(first, ROLE).runId).toBe(first.runId);
		const reset = await t.action(internal.migrations.operate, {
			op: "reset",
			id: ROLE,
		});
		expect(step(reset, ROLE).runId).toBeNull();
		// A failed Step keeps the id of the run it failed in, until mark-done.
		await t.mutation(internal.users.addMany, { names: ["poison"] });
		await t.action(internal.migrations.apply, {}).catch(() => {});
		expect(
			step(await t.query(internal.migrations.status, {}), ROLE).runId,
		).not.toBeNull();
		const marked = await t.action(internal.migrations.operate, {
			op: "markDone",
			id: ROLE,
			reason: "fixed by hand",
		});
		expect(step(marked, ROLE).runId).toBeNull();
	});
});

describe("dry run, status and apply agree on resume or start over", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const V1 = internal.testing.startV1;
	const V2 = internal.testing.startV2;
	type Id = "start-counters" | "start-member";
	type Plan = typeof V1;

	async function drain(t: ReturnType<typeof initConvexTest>) {
		for (let i = 0; i < 80; i++) {
			vi.advanceTimersByTime(1);
			await t.finishInProgressScheduledFunctions();
			if ((await t.query(V1.status, {})).run === null) return;
		}
		throw new Error("the run did not finish");
	}

	async function units(t: ReturnType<typeof initConvexTest>, n: number) {
		for (let i = 0; i < n; i++) {
			vi.advanceTimersByTime(1);
			await t.finishInProgressScheduledFunctions();
		}
	}

	test("an unfinished Orphan makes the dry run refuse with apply's error", async () => {
		const t = initConvexTest();
		await t.action(internal.testing.altPlan.apply, {}).catch(() => {});
		const fromApply = await failure(t.action(internal.migrations.apply, {}));
		for (const args of [
			{ dryRun: true },
			{ dryRun: true, only: "countries" as const },
		]) {
			const fromDryRun = await failure(
				t.action(internal.migrations.apply, args),
			);
			expect(fromDryRun.message).toBe(fromApply.message);
		}
	});

	/** Bring one Step into a state with the v1 Plan. */
	async function setUp(
		t: ReturnType<typeof initConvexTest>,
		id: Id,
		state: "failed" | "canceled" | "done",
	) {
		await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { name: "ada" });
			for (let i = 0; i < 5; i++) {
				await ctx.db.insert("requests", { userId, amount: 1 });
				await ctx.db.insert("users", { name: `u${i}` });
			}
			if (state === "failed") {
				await ctx.db.insert("requests", { userId, amount: -1 });
				await ctx.db.insert("users", { name: "poison" });
			}
		});
		await t.action(V1.apply, { only: id, wait: false });
		if (state === "canceled") {
			// The Rebuild's clear is one unit, then a Batch; the Migration a Batch.
			await units(t, id === "start-counters" ? 2 : 1);
			await t.action(V1.operate, { op: "cancel" });
		}
		await drain(t);
		const row = step(await t.query(V1.status, {}), id);
		expect(row.state).toBe(state === "canceled" ? "pending" : state);
		if (state !== "done") expect(row.processed).toBeGreaterThan(0);
	}

	/** What each of the three says. */
	async function predictions(
		t: ReturnType<typeof initConvexTest>,
		plan: Plan,
		id: Id,
	) {
		const reason = step(await t.query(plan.status, {}), id).reason ?? "";
		const dry = step(
			await t.action(plan.apply, { dryRun: true, only: id }),
			id,
		);
		const started = await t.action(plan.apply, { only: id, wait: false });
		await drain(t);
		const events = (await t.query(plan.status, { events: id })).events!;
		const begin = events.find(
			(e) =>
				e.runId === started.runId &&
				(e.type === "started" || e.type === "resumed"),
		);
		return {
			status: /starts it over|rebuilds it/.test(reason) ? "over" : "resume",
			dryRun:
				dry.changes?.some(
					(c) => c.op === "delete" && c.table === "requestCounters",
				) || /starts it over|rebuilds it/.test(dry.reason ?? "")
					? "over"
					: "resume",
			apply: begin?.type === "started" ? "over" : "resume",
			reasons: [reason, dry.reason],
		};
	}

	const cases: [
		Id,
		"failed" | "canceled" | "done",
		"none" | "version" | "request",
		"over" | "resume",
	][] = [
		["start-member", "failed", "none", "resume"],
		["start-member", "canceled", "none", "resume"],
		["start-counters", "failed", "none", "resume"],
		["start-counters", "canceled", "none", "resume"],
		["start-counters", "failed", "version", "over"],
		["start-counters", "canceled", "version", "over"],
		["start-counters", "done", "version", "over"],
		["start-counters", "failed", "request", "over"],
		["start-counters", "canceled", "request", "over"],
		["start-counters", "done", "request", "over"],
	];

	test.each(cases)(
		"%s %s, change: %s, expected: %s",
		async (id, state, change, expected) => {
			const t = initConvexTest();
			await setUp(t, id, state);
			if (change === "request") {
				await t.action(V1.apply, {
					only: "start-member",
					rebuild: ["start-counters"],
					wait: false,
				});
				await drain(t);
			}
			const plan = change === "version" ? V2 : V1;
			const said = await predictions(t, plan, id);
			expect(
				{ status: said.status, dryRun: said.dryRun, apply: said.apply },
				said.reasons.join(" | "),
			).toEqual({ status: expected, dryRun: expected, apply: expected });
		},
	);
});

describe("resume reports from the run's own record", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const V1 = internal.testing.startV1;

	async function drain(t: ReturnType<typeof initConvexTest>) {
		for (let i = 0; i < 80; i++) {
			vi.advanceTimersByTime(1);
			await t.finishInProgressScheduledFunctions();
			if ((await t.query(V1.status, {})).run === null) return;
		}
		throw new Error("the run did not finish");
	}

	/** A whole-Plan run that fails on start-member after start-counters is done. */
	async function failedRun(t: ReturnType<typeof initConvexTest>) {
		await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { name: "poison" });
			await ctx.db.insert("requests", { userId, amount: 1 });
		});
		const { runId } = await t.action(V1.apply, { wait: false });
		await drain(t);
		const s = await t.query(V1.status, {});
		expect(s.steps.map((x) => x.state)).toEqual(["done", "failed"]);
		return runId!;
	}

	test("a scope that differs is refused after the run ended too", async () => {
		const t = initConvexTest();
		const whole = await failedRun(t);
		const wide = await failure(
			t.action(V1.apply, { resume: whole, only: "start-counters" }),
		);
		expect(wide.message).toMatch(
			new RegExp(`^Run ${whole} covers the whole Plan\\. Resume it with: `),
		);
		const { runId: narrow } = await t.action(V1.apply, {
			only: "start-counters",
			wait: false,
		});
		await drain(t);
		const wider = await failure(t.action(V1.apply, { resume: narrow! }));
		expect(wider.message).toMatch(
			new RegExp(`^Run ${narrow} was started with only "start-counters"\\.`),
		);
	});

	test("a run that finished in the background returns its result", async () => {
		const t = initConvexTest();
		await t.run(async (ctx) => {
			await ctx.db.insert("users", { name: "ada" });
		});
		const { runId } = await t.action(V1.apply, { wait: false });
		await drain(t);
		const result = await t.action(V1.apply, { resume: runId! });
		expect(result).toMatchObject({ ok: true, runId });
		expect(result.steps.map((s) => s.state)).toEqual(["done", "done"]);
	});

	test("an unknown run id is refused", async () => {
		const t = initConvexTest();
		await t.action(V1.apply, { wait: false });
		await drain(t);
		const error = await failure(t.action(V1.apply, { resume: "nope" }));
		expect(error.message).toBe(
			'No run "nope" on this deployment. Start one with npx convex-improved-migration apply --module testing/startV1.',
		);
	});

	test("a run that failed still reports its failure after mark-done", async () => {
		const t = initConvexTest();
		const runId = await failedRun(t);
		await t.action(V1.operate, {
			op: "markDone",
			id: "start-member",
			reason: "fixed by hand",
		});
		const error = await failure(t.action(V1.apply, { resume: runId }));
		expect(error.message).toMatch(/^Step "start-member" \(migration\) failed/);
	});
});
