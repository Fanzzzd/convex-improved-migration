/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { HEARTBEAT_MS, LEASE_TTL_MS, MAX_RESTARTS } from "../shared.js";
import { api, internal } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

type T = ReturnType<typeof initConvexTest>;
const RUN = "run-1";

// Fake timers keep scheduled jobs pending until a test ends them.
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

/** A scheduled job that stays pending. Stands in for a driver or a sentinel. */
async function pendingJob(t: T): Promise<string> {
	return await t.run((ctx) =>
		ctx.scheduler.runAfter(3_600_000, internal.lib.sentinel, { token: "none" }),
	);
}

async function cancelJob(t: T, job: string) {
	await t.run(async (ctx) => {
		const id = ctx.db.system.normalizeId("_scheduled_functions", job);
		if (!id) throw new Error(`not a scheduled job: ${job}`);
		await ctx.scheduler.cancel(id);
	});
}

async function seedLease(
	t: T,
	fields: {
		driveJob?: string;
		expiresAt?: number;
		throttleRetries?: number;
		ticks?: number;
		restarts?: number;
		restartTicks?: number;
	} = {},
) {
	await t.run((ctx) =>
		ctx.db.insert("lease", {
			holder: `background:${RUN}:first`,
			runId: RUN,
			expiresAt: fields.expiresAt ?? Date.now() + LEASE_TTL_MS,
			mode: "background",
			startedAt: Date.now(),
			ticks: fields.ticks ?? 0,
			plan: [],
			budgetMs: 1000,
			driveJob: fields.driveJob,
			throttleRetries: fields.throttleRetries,
			restarts: fields.restarts,
			restartTicks: fields.restartTicks,
		}),
	);
}

const lease = (t: T) => t.run((ctx) => ctx.db.query("lease").first());
const runEvents = (t: T) =>
	t.run(async (ctx) =>
		(await ctx.db.query("events").collect()).map(
			(e) => `${e.type}: ${e.detail}`,
		),
	);

describe("watchdog", () => {
	test("leaves a run alone while its driver job is pending", async () => {
		const t = initConvexTest();
		const job = await pendingJob(t);
		await seedLease(t, { driveJob: job });
		await t.mutation(internal.lib.watchdog, { runId: RUN });
		expect(await lease(t)).toMatchObject({
			holder: `background:${RUN}:first`,
			driveJob: job,
		});
		expect((await lease(t))!.restarts).toBeUndefined();
		expect(await runEvents(t)).toEqual([]);
	});

	test("starts a new driver under a new holder when the job ended", async () => {
		const t = initConvexTest();
		const job = await pendingJob(t);
		await seedLease(t, { driveJob: job });
		await cancelJob(t, job);
		await t.mutation(internal.lib.watchdog, { runId: RUN });
		const after = (await lease(t))!;
		expect(after.holder).not.toBe(`background:${RUN}:first`);
		expect(after.holder.startsWith(`background:${RUN}:`)).toBe(true);
		expect(after.driveJob).not.toBe(job);
		expect(after).toMatchObject({ restarts: 1, restartTicks: 0 });
		expect(await runEvents(t)).toEqual([
			"restarted: driver job canceled; restart 1",
		]);
	});

	test("treats a run with no recorded driver job as lost", async () => {
		const t = initConvexTest();
		await seedLease(t);
		await t.mutation(internal.lib.watchdog, { runId: RUN });
		expect(await runEvents(t)).toEqual([
			"restarted: driver job missing; restart 1",
		]);
	});

	test(`gives up after ${MAX_RESTARTS} restarts in a row without progress`, async () => {
		const t = initConvexTest();
		await seedLease(t);
		for (let i = 1; i <= MAX_RESTARTS; i++) {
			await t.mutation(internal.lib.watchdog, { runId: RUN });
			const now = (await lease(t))!;
			expect(now.restarts).toBe(i);
			await cancelJob(t, now.driveJob!);
		}
		await t.mutation(internal.lib.watchdog, { runId: RUN });
		expect(await lease(t)).toBeNull();
		expect((await runEvents(t)).at(-1)).toBe(
			`stalled: ${MAX_RESTARTS} restart(s) without progress`,
		);
	});

	test("a unit of work between restarts resets the count", async () => {
		const t = initConvexTest();
		await seedLease(t);
		for (let i = 0; i < 2; i++) {
			await t.mutation(internal.lib.watchdog, { runId: RUN });
			await cancelJob(t, (await lease(t))!.driveJob!);
		}
		expect((await lease(t))!.restarts).toBe(2);
		await t.run(async (ctx) => {
			const row = (await ctx.db.query("lease").first())!;
			await ctx.db.patch("lease", row._id, { ticks: row.ticks + 1 });
		});
		await t.mutation(internal.lib.watchdog, { runId: RUN });
		expect(await lease(t)).toMatchObject({ restarts: 1, restartTicks: 1 });
	});

	test("ignores a run that ended or was replaced", async () => {
		const t = initConvexTest();
		await seedLease(t);
		await t.mutation(internal.lib.watchdog, { runId: "another-run" });
		expect((await lease(t))!.holder).toBe(`background:${RUN}:first`);
		expect(await runEvents(t)).toEqual([]);
	});
});

describe("markDone decides in its own transaction", () => {
	async function doneStep(
		t: T,
		kind: "migration" | "rebuild",
		version?: string,
	) {
		await t.run((ctx) =>
			ctx.db.insert("steps", {
				name: "backfill",
				kind,
				state: "done",
				via: "ran",
				version,
				doneAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
	}
	const row = (t: T) => t.run((ctx) => ctx.db.query("steps").first());

	test("a Step a run finished is refused and keeps via ran", async () => {
		const t = initConvexTest();
		await doneStep(t, "migration");
		expect(
			await t.mutation(api.lib.markDone, {
				name: "backfill",
				kind: "migration",
				reason: "by hand",
			}),
		).toBe("done");
		expect(await row(t)).toMatchObject({ state: "done", via: "ran" });
	});

	test("a Rebuild is refused while a snapshot import is suspected", async () => {
		const t = initConvexTest();
		await doneStep(t, "rebuild", "1");
		const job = await pendingJob(t);
		await cancelJob(t, job);
		await t.run((ctx) =>
			ctx.db.insert("meta", { sentinelId: job, token: "a" }),
		);
		const mark = (kind: "rebuild" | "migration", version?: string) =>
			t.mutation(api.lib.markDone, {
				name: kind === "rebuild" ? "backfill" : "other",
				kind,
				version,
				reason: "by hand",
			});
		expect(await mark("rebuild", "2")).toBe("import");
		expect(await row(t)).toMatchObject({ via: "ran", version: "1" });
		// The import does not touch other kinds.
		expect(await mark("migration")).toBe("ok");
	});

	test("a Rebuild that apply would start over may be marked", async () => {
		const t = initConvexTest();
		await doneStep(t, "rebuild", "1");
		const mark = (version: string) =>
			t.mutation(api.lib.markDone, {
				name: "backfill",
				kind: "rebuild",
				version,
				reason: "by hand",
			});
		expect(await mark("1")).toBe("done");
		expect(await mark("2")).toBe("ok");
		expect(await row(t)).toMatchObject({ via: "marked", version: "2" });
	});
});

describe("reset and a stalled Step", () => {
	async function runningStep(t: T) {
		await t.run((ctx) =>
			ctx.db.insert("steps", {
				name: "backfill",
				kind: "migration",
				state: "running",
				runId: RUN,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
	}

	test("refuses a Step whose run holds a live Lease", async () => {
		const t = initConvexTest();
		await runningStep(t);
		await seedLease(t);
		expect(await t.mutation(api.lib.reset, { name: "backfill" })).toBe(
			"running",
		);
		expect(
			await t.mutation(api.lib.markDone, {
				name: "backfill",
				kind: "migration",
				reason: "by hand",
			}),
		).toBe("running");
	});

	test("allows a Step whose run let its Lease expire", async () => {
		const t = initConvexTest();
		await runningStep(t);
		await seedLease(t, { expiresAt: Date.now() - 1 });
		expect(await t.mutation(api.lib.reset, { name: "backfill" })).toBe("ok");
		const row = await t.run((ctx) => ctx.db.query("steps").first());
		expect(row!.state).toBe("pending");
	});

	test("allows a Step whose run is gone", async () => {
		const t = initConvexTest();
		await runningStep(t);
		expect(await t.mutation(api.lib.reset, { name: "backfill" })).toBe("ok");
	});
});

describe("a suspected snapshot import", () => {
	async function doneRebuild(t: T) {
		await t.run((ctx) =>
			ctx.db.insert("steps", {
				name: "counters",
				kind: "rebuild",
				state: "done",
				via: "ran",
				version: "1",
				doneAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
	}
	const read = async (t: T) => ({
		suspected: (await t.query(api.lib.status, {})).restoreSuspected,
		ready: await t.query(api.lib.isReady, { name: "counters", version: "1" }),
	});

	test("no sentinel recorded yet: not suspected", async () => {
		const t = initConvexTest();
		await doneRebuild(t);
		expect(await read(t)).toEqual({ suspected: false, ready: true });
	});

	test("the sentinel job is pending: not suspected", async () => {
		const t = initConvexTest();
		await doneRebuild(t);
		const job = await pendingJob(t);
		await t.run((ctx) =>
			ctx.db.insert("meta", { sentinelId: job, token: "a" }),
		);
		expect(await read(t)).toEqual({ suspected: false, ready: true });
	});

	test("the sentinel fired: not suspected", async () => {
		const t = initConvexTest();
		await doneRebuild(t);
		const job = await pendingJob(t);
		await cancelJob(t, job);
		await t.run((ctx) =>
			ctx.db.insert("meta", {
				sentinelId: job,
				token: "a",
				sentinelFiredAt: Date.now(),
			}),
		);
		expect(await read(t)).toEqual({ suspected: false, ready: true });
	});

	test("the sentinel job was canceled by a later apply: suspected, Rebuilds not ready", async () => {
		const t = initConvexTest();
		await doneRebuild(t);
		const job = await pendingJob(t);
		await cancelJob(t, job);
		await t.run((ctx) =>
			ctx.db.insert("meta", { sentinelId: job, token: "a" }),
		);
		expect(await read(t)).toEqual({ suspected: true, ready: false });
	});

	test("the sentinel id is from another deployment: suspected, Rebuilds not ready", async () => {
		const t = initConvexTest();
		await doneRebuild(t);
		await t.run((ctx) =>
			ctx.db.insert("meta", {
				sentinelId: "from-another-deployment",
				token: "a",
			}),
		);
		expect(await read(t)).toEqual({ suspected: true, ready: false });
	});

	test("a Migration stays ready while an import is suspected", async () => {
		const t = initConvexTest();
		await t.run(async (ctx) => {
			await ctx.db.insert("steps", {
				name: "backfill",
				kind: "migration",
				state: "done",
				via: "ran",
				doneAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert("meta", { sentinelId: "from-another-deployment" });
		});
		expect(await t.query(api.lib.isReady, { name: "backfill" })).toBe(true);
	});
});

describe("cancel", () => {
	async function runningStep(t: T) {
		await t.run((ctx) =>
			ctx.db.insert("steps", {
				name: "backfill",
				kind: "migration",
				state: "running",
				runId: RUN,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
	}
	const stepState = (t: T) =>
		t.run(async (ctx) => (await ctx.db.query("steps").first())!.state);

	test("marks the Lease canceled while the driver job is alive", async () => {
		const t = initConvexTest();
		await runningStep(t);
		await seedLease(t, { driveJob: await pendingJob(t) });
		expect(await t.mutation(api.lib.cancel, {})).toBe("backfill");
		expect((await lease(t))!.holder).toBe("canceled");
		expect(await stepState(t)).toBe("pending");
	});

	test("with a run id and no run left, says the run ended", async () => {
		const t = initConvexTest();
		expect(await t.mutation(api.lib.cancel, { runId: RUN })).toEqual({
			ended: true,
		});
		expect(await t.mutation(api.lib.cancel, {})).toBe(null);
	});

	test("with a run id, leaves a newer run alone", async () => {
		const t = initConvexTest();
		await runningStep(t);
		await seedLease(t, { driveJob: await pendingJob(t) });
		expect(await t.mutation(api.lib.cancel, { runId: "an-older-run" })).toEqual(
			{ other: RUN },
		);
		expect((await lease(t))!.holder).not.toBe("canceled");
		expect(await stepState(t)).toBe("running");
		expect(await t.mutation(api.lib.cancel, { runId: RUN })).toBe("backfill");
		expect((await lease(t))!.holder).toBe("canceled");
	});

	test("drops the Lease when the driver job already ended", async () => {
		const t = initConvexTest();
		await runningStep(t);
		const job = await pendingJob(t);
		await seedLease(t, { driveJob: job });
		await cancelJob(t, job);
		expect(await t.mutation(api.lib.cancel, {})).toBe("backfill");
		expect(await lease(t)).toBeNull();
		expect(await stepState(t)).toBe("pending");
	});

	test("drops a Lease that expired", async () => {
		const t = initConvexTest();
		await runningStep(t);
		await seedLease(t, {
			driveJob: await pendingJob(t),
			expiresAt: Date.now() - 1,
		});
		await t.mutation(api.lib.cancel, {});
		expect(await lease(t)).toBeNull();
	});

	test("a second cancel drops a canceled Lease no driver came back for", async () => {
		const t = initConvexTest();
		await seedLease(t, { driveJob: await pendingJob(t) });
		await t.mutation(api.lib.cancel, {});
		expect((await lease(t))!.holder).toBe("canceled");
		await t.mutation(api.lib.cancel, {});
		expect((await lease(t))!.holder).toBe("canceled");
		vi.setSystemTime(Date.now() + LEASE_TTL_MS + 1);
		await t.mutation(api.lib.cancel, {});
		expect(await lease(t)).toBeNull();
	});
});

describe("adopt", () => {
	test("clears the error and progress of an earlier failed attempt", async () => {
		const t = initConvexTest();
		await t.run(async (ctx) => {
			await ctx.db.insert("steps", {
				name: "backfill",
				kind: "migration",
				state: "failed",
				error: {
					message: "boom",
					batch: 2,
					batchSize: 100,
					processed: 100,
				},
				runId: "run-0",
				startedAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert("progress", {
				name: "backfill",
				phase: "migrate",
				cursor: "c",
				processed: 100,
				skipped: 0,
				batches: 1,
				updatedAt: Date.now(),
			});
		});
		expect(await t.mutation(api.lib.adopt, { names: ["backfill"] })).toEqual({
			adopted: 1,
			alreadyDone: 0,
			running: [],
		});
		const row = await t.run((ctx) => ctx.db.query("steps").first());
		expect(row).toMatchObject({ state: "done", via: "adopted" });
		expect(row!.error).toBeUndefined();
		// No run did this, so the row names none.
		expect(row!.runId).toBeUndefined();
		expect(row!.startedAt).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.query("progress").first())).toBeNull();
	});

	test("records nothing while a live run works on one of the Steps", async () => {
		const t = initConvexTest();
		await t.run((ctx) =>
			ctx.db.insert("steps", {
				name: "backfill",
				kind: "migration",
				state: "running",
				runId: RUN,
				updatedAt: Date.now(),
			}),
		);
		await seedLease(t);
		expect(
			await t.mutation(api.lib.adopt, { names: ["other", "backfill"] }),
		).toEqual({ adopted: 0, alreadyDone: 0, running: ["backfill"] });
		expect(await t.run((ctx) => ctx.db.query("steps").collect())).toHaveLength(
			1,
		);
	});
});

/** The `retries` argument of every scheduled driver job. */
const driveRetries = (t: T) =>
	t.run(async (ctx) =>
		(await ctx.db.system.query("_scheduled_functions").collect())
			.filter((j) => j.name.endsWith("drive"))
			.map((j) => (j.args[0] as { retries?: number }).retries ?? 0),
	);

describe("throttle retries in a row cross every boundary", () => {
	const holder = `background:${RUN}:first`;
	const base = { plan: [], runId: RUN, holder, budgetMs: 1000 };

	test("handOff and continueDrive store them and pass them to the next driver", async () => {
		for (const fn of [api.lib.handOff, api.lib.continueDrive]) {
			const t = initConvexTest();
			await seedLease(t);
			await t.mutation(fn, { ...base, retries: 5 });
			expect((await lease(t))!.throttleRetries).toBe(5);
			expect(await driveRetries(t)).toEqual([5]);
		}
	});

	test("a watchdog restart passes them on", async () => {
		const t = initConvexTest();
		const job = await pendingJob(t);
		await cancelJob(t, job);
		await seedLease(t, { driveJob: job, throttleRetries: 2 });
		await t.mutation(internal.lib.watchdog, { runId: RUN });
		expect(await driveRetries(t)).toEqual([2]);
	});

	test("resume hands them to the foreground apply", async () => {
		const t = initConvexTest();
		await seedLease(t, { throttleRetries: 6 });
		const back = await t.mutation(api.lib.resume, { runId: RUN });
		expect(back).toMatchObject({ retries: 6 });
		expect(back.holder).not.toBeNull();
	});

	test("a unit that goes through clears them", async () => {
		const t = initConvexTest();
		await seedLease(t, { throttleRetries: 4 });
		await t.mutation(api.lib.advance, { plan: [], runId: RUN, holder });
		expect((await lease(t))!.throttleRetries).toBeUndefined();
	});

	test("handOff keeps the restart count when the lap made no progress", async () => {
		for (const [ticks, expected] of [
			[5, 2],
			[6, 0],
		] as const) {
			const t = initConvexTest();
			await seedLease(t, { ticks, restarts: 2, restartTicks: 5 });
			await t.mutation(api.lib.handOff, base);
			expect((await lease(t))!.restarts).toBe(expected);
		}
	});
});

describe("a handover after waiting on a throttle", () => {
	const throttled = {
		retries: 2,
		waitedMs: 3000,
		message: "Too many writes per second.",
	};

	test("handOff and continueDrive record the wait", async () => {
		const t = initConvexTest();
		await seedLease(t);
		const holder = `background:${RUN}:first`;
		expect(
			await t.mutation(api.lib.continueDrive, {
				plan: [],
				runId: RUN,
				holder,
				budgetMs: 1000,
				throttled,
			}),
		).toBe(true);
		expect(
			await t.mutation(api.lib.handOff, {
				plan: [],
				runId: RUN,
				holder,
				budgetMs: 1000,
				throttled,
			}),
		).toBe("handed");
		const events = await runEvents(t);
		expect(
			events.filter(
				(e) =>
					e ===
					"write throttled: waited 3000 ms over 2 retries: Too many writes per second.",
			),
		).toHaveLength(2);
	});
});

describe("recordAbort", () => {
	test("says canceled when a cancel came first", async () => {
		const t = initConvexTest();
		await seedLease(t, { driveJob: await pendingJob(t) });
		await t.mutation(api.lib.cancel, {});
		expect(
			await t.mutation(api.lib.recordAbort, {
				plan: [],
				runId: RUN,
				holder: `background:${RUN}:first`,
				message: "boom",
			}),
		).toEqual({ retry: false, stopped: "canceled" });
	});
});

describe("the run record", () => {
	const runs = (t: T) =>
		t.run(async (ctx) =>
			(await ctx.db.query("runs").collect()).map((r) => ({
				runId: r.runId,
				outcome: r.outcome ?? null,
				by: r.by ?? null,
				failed: r.failure?.name ?? null,
			})),
		);
	const record = async (t: T, runId: string) =>
		(await runs(t)).find((r) => r.runId === runId);
	const start = (t: T, runId: string, mode: "foreground" | "background") =>
		t.mutation(api.lib.prepare, { plan: [], runId, mode, budgetMs: 1000 });
	const ended = async (t: T, runId: string) => {
		const back = await t.mutation(api.lib.resume, { runId });
		return "ended" in back ? back.ended : undefined;
	};

	test("done: the last unit records it", async () => {
		const t = initConvexTest();
		const { holder } = await start(t, "A", "foreground");
		await t.mutation(api.lib.advance, {
			plan: [],
			runId: "A",
			holder: holder!,
		});
		expect(await record(t, "A")).toMatchObject({ outcome: "done" });
		expect(await ended(t, "A")).toMatchObject({ outcome: "done" });
	});

	test("failed: a recorded abort records the failure", async () => {
		const t = initConvexTest();
		const { holder } = await start(t, "A", "foreground");
		const entry = {
			name: "backfill",
			handle: "unused",
			kind: "migration" as const,
			oneShot: false,
			verify: false,
			clear: false,
			batchSize: 10,
		};
		await t.mutation(api.lib.recordAbort, {
			plan: [entry],
			runId: "A",
			holder: holder!,
			message: "boom",
		});
		expect(await record(t, "A")).toMatchObject({
			outcome: "failed",
			failed: "backfill",
		});
		const end = await ended(t, "A");
		expect(end?.outcome).toBe("failed");
		expect(end?.failure?.error.message).toBe("boom");
	});

	test("canceled: cancel records it", async () => {
		const t = initConvexTest();
		await start(t, "A", "background");
		await t.mutation(api.lib.cancel, {});
		expect(await record(t, "A")).toMatchObject({ outcome: "canceled" });
		expect(await ended(t, "A")).toMatchObject({ outcome: "canceled" });
	});

	test("taken over: the next run's prepare records it, with that run", async () => {
		const t = initConvexTest();
		await start(t, "A", "background");
		await start(t, "B", "foreground");
		expect(await record(t, "A")).toMatchObject({
			outcome: "taken over",
			by: "B",
		});
		expect(await record(t, "B")).toMatchObject({ outcome: null });
		expect(await ended(t, "A")).toMatchObject({
			outcome: "taken over",
			by: "B",
		});
	});

	test("stalled: the watchdog records it when it gives up", async () => {
		const t = initConvexTest();
		await start(t, "A", "background");
		for (let i = 0; i <= MAX_RESTARTS; i++) {
			const current = await lease(t);
			if (!current) break;
			await cancelJob(t, current.driveJob!);
			await t.mutation(internal.lib.watchdog, { runId: "A" });
		}
		expect(await lease(t)).toBeNull();
		expect(await record(t, "A")).toMatchObject({ outcome: "stalled" });
		expect(await ended(t, "A")).toMatchObject({ outcome: "stalled" });
	});

	test("the first outcome stays: a cancel or a takeover after done keeps done", async () => {
		const t = initConvexTest();
		const { holder } = await start(t, "A", "foreground");
		await t.mutation(api.lib.advance, {
			plan: [],
			runId: "A",
			holder: holder!,
		});
		// The release did not happen, so the Lease is still there.
		await t.mutation(api.lib.cancel, {});
		await start(t, "B", "foreground");
		expect(await record(t, "A")).toMatchObject({ outcome: "done", by: null });
	});

	test("a dry run writes no record and takes nothing over", async () => {
		const t = initConvexTest();
		await start(t, "A", "foreground");
		await t.mutation(api.lib.prepare, { plan: [], runId: "R", mode: "read" });
		expect(await runs(t)).toEqual([
			{ runId: "A", outcome: null, by: null, failed: null },
		]);
	});

	test("resume with no record, and with a Lease from before records existed", async () => {
		const t = initConvexTest();
		expect(await t.mutation(api.lib.resume, { runId: "nope" })).toMatchObject({
			holder: null,
			unknown: true,
		});
		await seedLease(t);
		const back = await t.mutation(api.lib.resume, { runId: RUN });
		expect(back.holder).not.toBeNull();
	});
});

describe("handOff", () => {
	const args = { plan: [], runId: RUN, budgetMs: 1000 };

	test("says canceled when a cancel came first", async () => {
		const t = initConvexTest();
		await seedLease(t, { driveJob: await pendingJob(t) });
		await t.mutation(api.lib.cancel, {});
		expect(
			await t.mutation(api.lib.handOff, { ...args, holder: "foreground:x" }),
		).toBe("canceled");
	});

	test("says lost when another run holds the Lease", async () => {
		const t = initConvexTest();
		await seedLease(t);
		expect(
			await t.mutation(api.lib.handOff, {
				...args,
				runId: "run-2",
				holder: "foreground:run-2:x",
			}),
		).toBe("lost");
	});
});

describe("batch size after an abort", () => {
	const LIMIT =
		"Uncaught Error: Too many bytes read in a single function execution (limit: 16777216 bytes).\n    at handler (../convex/migrations.ts:10:3)";
	const entry = {
		name: "counters",
		handle: "",
		kind: "rebuild" as const,
		oneShot: false,
		version: "1",
		verify: false,
		clear: true,
		batchSize: 40,
	};
	async function abort(t: T, plan: (typeof entry & { clearOnce?: boolean })[]) {
		await seedLease(t);
		const holder = (await lease(t))!.holder;
		return await t.mutation(api.lib.recordAbort, {
			plan,
			runId: RUN,
			holder,
			message: LIMIT,
		});
	}
	const progress = (t: T) => t.run((ctx) => ctx.db.query("progress").first());

	test("a limit error with the runtime's prefix halves the Batch", async () => {
		const t = initConvexTest();
		expect(await abort(t, [entry])).toEqual({ retry: true });
		expect((await progress(t))!.batchSize).toBe(20);
		expect(await runEvents(t)).toContain(
			"batch shrunk: 40 -> 20: Too many bytes read in a single function execution (limit: 16777216 bytes). (at handler (../convex/migrations.ts:10:3))",
		);
	});

	test("a limit error in a one-call clear fails the Step at once", async () => {
		const t = initConvexTest();
		const result = await abort(t, [{ ...entry, clearOnce: true }]);
		expect(result).toMatchObject({
			retry: false,
			failure: { name: "counters" },
		});
		// Not halved.
		expect((await progress(t))!.batchSize).toBe(40);
	});

	test("a smaller batchSize in code wins over the saved one", async () => {
		const t = initConvexTest();
		await t.run(async (ctx) => {
			await ctx.db.insert("steps", {
				name: "counters",
				kind: "rebuild",
				state: "running",
				version: "1",
				runId: RUN,
				updatedAt: Date.now(),
			});
			await ctx.db.insert("progress", {
				name: "counters",
				phase: "migrate",
				cursor: "c",
				processed: 400,
				skipped: 0,
				batches: 4,
				batchSize: 100,
				updatedAt: Date.now(),
			});
		});
		expect(await abort(t, [{ ...entry, batchSize: 10 }])).toEqual({
			retry: true,
		});
		expect((await progress(t))!.batchSize).toBe(5);
	});
});

describe("Lease renewal", () => {
	const tick = async (t: T) => {
		const holder = (await lease(t))!.holder;
		await t.mutation(api.lib.advance, { plan: [], runId: RUN, holder });
		return (await lease(t))!;
	};

	test("a driver renews the Lease at most every HEARTBEAT_MS", async () => {
		const t = initConvexTest();
		await seedLease(t);
		const start = (await lease(t))!;
		expect(await tick(t)).toMatchObject({
			ticks: 0,
			expiresAt: start.expiresAt,
		});
		vi.setSystemTime(Date.now() + HEARTBEAT_MS - 1);
		expect((await tick(t)).ticks).toBe(0);
		vi.setSystemTime(Date.now() + 1);
		const renewed = await tick(t);
		expect(renewed.ticks).toBe(1);
		expect(renewed.expiresAt).toBe(Date.now() + LEASE_TTL_MS);
		expect((await tick(t)).ticks).toBe(1);
	});

	test("the first unit after a restart or handover counts at once", async () => {
		const t = initConvexTest();
		await seedLease(t);
		await t.run(async (ctx) => {
			const row = (await ctx.db.query("lease").first())!;
			await ctx.db.patch("lease", row._id, { ticks: 4, restartTicks: 4 });
		});
		expect((await tick(t)).ticks).toBe(5);
		expect((await tick(t)).ticks).toBe(5);
	});
});
