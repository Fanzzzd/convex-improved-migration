// The component owns Step state, progress, the Event log and the Lease. It
// never reads app tables: every Batch calls the app's runStep through a handle.
import { ConvexError, v } from "convex/values";
import type { FunctionHandle } from "convex/server";
import {
	internalAction,
	internalMutation,
	mutation,
	query,
	type MutationCtx,
	type QueryCtx,
} from "./_generated/server.js";
import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import {
	HEARTBEAT_MS,
	LEASE_TTL_MS,
	MAX_RESTARTS,
	MAX_SAMPLES,
	SHORT_SENTINEL_FLAG,
	abortResultValidator,
	cleanError,
	advanceResultValidator,
	failureValidator,
	isRateLimit,
	kindValidator,
	phaseValidator,
	planEntryValidator,
	retryTransient,
	runLoop,
	runOutcomeValidator,
	stateValidator,
	startOver,
	stepErrorValidator,
	throttleValidator,
	viaValidator,
	type BatchResult,
	type ClearResult,
	type Failure,
	type RunOutcome,
	type PlanEntry,
	type RunStepArgs,
	type StepError,
	type VerifyResult,
} from "../shared.js";

type StepHandle = FunctionHandle<"mutation", RunStepArgs, unknown>;
type Row = Doc<"steps">;
type Progress = Doc<"progress">;

// Nested limits for a Batch. They are tighter than the platform limits, so a
// Batch that runs out of budget fails inside its own sub-transaction and this
// mutation can still record the error and shrink the Batch.
const BATCH_LIMITS = {
	bytesRead: 12 * 1024 * 1024,
	bytesWritten: 12 * 1024 * 1024,
	databaseQueries: 3_000,
	documentsRead: 24_000,
	documentsWritten: 12_000,
};

// Platform limit messages, for example "Too many bytes read in a single
// function execution (limit: ...)" or "Function execution timed out
// (maximum duration: 1s)". A user error that mentions a "limit" must not
// match: it would be retried with smaller Batches before failing.
const LIMIT_ERROR =
	/^(Too many [a-z ]+ in a single (function execution|transaction)|Function execution timed out|Transaction (is |was )?too large)/i;

export function isLimitError(message: string): boolean {
	return LIMIT_ERROR.test(message);
}

function errorMessage(e: unknown): string {
	return cleanError(e instanceof Error ? e.message : String(e));
}

async function getRow(ctx: MutationCtx, name: string): Promise<Row | null> {
	return await ctx.db
		.query("steps")
		.withIndex("by_name", (q) => q.eq("name", name))
		.unique();
}

async function getProgress(
	ctx: MutationCtx,
	name: string,
): Promise<Progress | null> {
	return await ctx.db
		.query("progress")
		.withIndex("by_name", (q) => q.eq("name", name))
		.unique();
}

async function getLease(ctx: MutationCtx) {
	return await ctx.db.query("lease").first();
}

async function logEvent(
	ctx: MutationCtx,
	name: string,
	type: string,
	runId?: string,
	detail?: string,
) {
	await ctx.db.insert("events", { name, type, at: Date.now(), runId, detail });
}

async function logThrottle(
	ctx: MutationCtx,
	name: string,
	runId: string,
	t: { retries: number; waitedMs: number; message: string },
) {
	await logEvent(
		ctx,
		name,
		isRateLimit(t.message) ? "write throttled" : "write conflict",
		runId,
		`waited ${t.waitedMs} ms over ${t.retries} retr${t.retries === 1 ? "y" : "ies"}: ${t.message}`,
	);
}

/**
 * What a Step had achieved, for the Event written when `reset` or a Rebuild
 * restart discards its progress. Keeps the audit evidence.
 */
function history(row: Row, prog: Progress | null): string {
	const done =
		row.state === "done"
			? `done via ${row.via}${row.doneAt ? ` at ${new Date(row.doneAt).toISOString()}` : ""}`
			: row.state;
	const version = row.version !== undefined ? `, version ${row.version}` : "";
	return `was ${done}${version}, processed ${prog?.processed ?? 0}, skipped ${prog?.skipped ?? 0}`;
}

/** True while a live driver is working on this Step. */
async function isBeingRun(ctx: MutationCtx, row: Row | null): Promise<boolean> {
	if (row?.state !== "running") return false;
	const lease = await getLease(ctx);
	return (
		lease !== null &&
		lease.runId === row.runId &&
		lease.holder !== "canceled" &&
		lease.expiresAt > Date.now()
	);
}

type Need = "skip" | "work" | "failed";

/**
 * The saved size is what the last Batch settled on. A smaller `batchSize` set
 * in code since then wins.
 */
function batchSizeOf(entry: PlanEntry, prog: Progress): number {
	return Math.min(prog.batchSize ?? entry.batchSize, entry.batchSize);
}

/** A limit error in a one-call clear is not helped by a smaller Batch. */
function shrinkHelps(entry: PlanEntry, prog: Progress): boolean {
	return !entry.oneShot && !(prog.phase === "clear" && entry.clearOnce);
}

function needs(entry: PlanEntry, row: Row | null, runId: string): Need {
	// A failure stops the run that hit it. The next run resumes the Step.
	if (row?.state === "failed" && row.runId === runId) return "failed";
	if (entry.kind === "seed") {
		return row?.state === "done" && row.runId === runId ? "skip" : "work";
	}
	if (entry.kind === "rebuild") {
		const current =
			row?.state === "done" &&
			row.version === entry.version &&
			!row.rebuildRequested;
		return current ? "skip" : "work";
	}
	return row?.state === "done" ? "skip" : "work";
}

function freshProgress(entry: PlanEntry, now: number) {
	return {
		name: entry.name,
		phase: entry.oneShot
			? undefined
			: entry.clear
				? ("clear" as const)
				: ("migrate" as const),
		cursor: null,
		processed: 0,
		skipped: 0,
		batches: 0,
		batchSize: entry.batchSize,
		notMigrated: undefined,
		samples: undefined,
		verified: undefined,
		updatedAt: now,
	};
}

async function writeProgress(
	ctx: MutationCtx,
	entry: PlanEntry,
	existing: Progress | null,
) {
	const value = freshProgress(entry, Date.now());
	if (existing) await ctx.db.replace("progress", existing._id, value);
	else await ctx.db.insert("progress", value);
}

/**
 * Bring the Step into the "running" state for this run, creating its rows if
 * needed. Seeds and outdated Rebuilds start over; everything else resumes
 * from its saved progress.
 */
async function startRow(
	ctx: MutationCtx,
	entry: PlanEntry,
	row: Row | null,
	runId: string,
): Promise<{ row: Row; prog: Progress }> {
	const now = Date.now();
	let prog = await getProgress(ctx, entry.name);
	if (!row) {
		const id = await ctx.db.insert("steps", {
			name: entry.name,
			kind: entry.kind,
			state: "running",
			version: entry.version,
			runId,
			startedAt: now,
			updatedAt: now,
		});
		await writeProgress(ctx, entry, prog);
		await logEvent(ctx, entry.name, "started", runId);
		return {
			row: (await ctx.db.get("steps", id))!,
			prog: (await getProgress(ctx, entry.name))!,
		};
	}
	// The same rule as the dry run and status use.
	const start = startOver(entry, row, prog !== null, { runId });
	if (start.over) {
		// A Rebuild that starts over records what the previous build achieved.
		const reason =
			start.why === null ? undefined : `${start.why}; ${history(row, prog)}`;
		await ctx.db.patch("steps", row._id, {
			state: "running",
			version: entry.version,
			rebuildRequested: false,
			error: undefined,
			runId,
			startedAt: now,
			updatedAt: now,
			// A Seed stays Ready while it runs again; a Rebuild does not.
			...(entry.kind === "seed"
				? {}
				: { via: undefined, reason: undefined, doneAt: undefined }),
		});
		await writeProgress(ctx, entry, prog);
		await logEvent(ctx, entry.name, "started", runId, reason);
	} else if (row.state !== "running" || row.runId !== runId) {
		await ctx.db.patch("steps", row._id, {
			state: "running",
			error: undefined,
			runId,
			updatedAt: now,
		});
		await logEvent(
			ctx,
			entry.name,
			"resumed",
			runId,
			`from batch ${prog!.batches + 1}`,
		);
	}
	prog = (await getProgress(ctx, entry.name))!;
	return { row: (await ctx.db.get("steps", row._id))!, prog };
}

async function markRan(ctx: MutationCtx, row: Row, runId: string) {
	const now = Date.now();
	await ctx.db.patch("steps", row._id, {
		state: "done",
		via: "ran",
		reason: undefined,
		doneAt: now,
		updatedAt: now,
		runId,
	});
	await logEvent(ctx, row.name, "done", runId, "via ran");
}

async function markFailed(
	ctx: MutationCtx,
	row: Row,
	prog: Progress,
	runId: string,
	message: string,
): Promise<StepError> {
	const error: StepError = {
		message,
		batch: prog.batches + 1,
		batchSize: prog.batchSize ?? 0,
		processed: prog.processed,
		phase: prog.phase,
	};
	await ctx.db.patch("steps", row._id, {
		state: "failed",
		error,
		runId,
		updatedAt: Date.now(),
	});
	await logEvent(ctx, row.name, "failed", runId, message);
	return error;
}

/**
 * Run one unit of work for the first Step in the Plan that needs it: one
 * Batch, one clear or verify page, or one Seed or `once` call. The app's
 * writes and the new progress commit together.
 */
export const advance = mutation({
	args: {
		plan: v.array(planEntryValidator),
		runId: v.string(),
		holder: v.string(),
		throttled: v.optional(throttleValidator),
	},
	returns: advanceResultValidator,
	handler: async (ctx, args) => {
		const lease = await getLease(ctx);
		if (!lease || lease.holder !== args.holder) {
			return lease?.holder === "canceled" && lease.runId === args.runId
				? { status: "canceled" as const }
				: { status: "preempted" as const };
		}
		// Renew the Lease when the last renewal is old enough, and on the first
		// unit after a handover or a watchdog restart, which the watchdog reads
		// as progress.
		// This unit goes through, so no throttle retries are in a row any more.
		const renewedAt = lease.expiresAt - LEASE_TTL_MS;
		const renew =
			Date.now() - renewedAt >= HEARTBEAT_MS ||
			lease.ticks === lease.restartTicks;
		if (renew || lease.throttleRetries !== undefined) {
			await ctx.db.patch("lease", lease._id, {
				...(renew
					? { expiresAt: Date.now() + LEASE_TTL_MS, ticks: lease.ticks + 1 }
					: {}),
				throttleRetries: undefined,
			});
		}

		for (const [i, entry] of args.plan.entries()) {
			const row = await getRow(ctx, entry.name);
			const need = needs(entry, row, args.runId);
			if (need === "skip") continue;
			const later = args.plan.slice(i + 1).map((e) => e.name);
			if (need === "failed") {
				const failure = {
					name: entry.name,
					kind: entry.kind,
					error: row!.error!,
					later,
				};
				await endRun(ctx, args.runId, { outcome: "failed", failure });
				return { status: "failed" as const, failure };
			}
			const running = await startRow(ctx, entry, row, args.runId);
			if (args.throttled)
				await logThrottle(ctx, entry.name, args.runId, args.throttled);
			const error = await runUnit(
				ctx,
				entry,
				running.row,
				running.prog,
				args.runId,
			);
			if (error) {
				const failure = { name: entry.name, kind: entry.kind, error, later };
				await endRun(ctx, args.runId, { outcome: "failed", failure });
				return { status: "failed" as const, failure };
			}
			return { status: "progress" as const, current: entry.name };
		}
		if (args.throttled)
			await logThrottle(ctx, "(run)", args.runId, args.throttled);
		await endRun(ctx, args.runId, { outcome: "done" });
		return { status: "done" as const };
	},
});

/** Returns the recorded error if the unit failed, otherwise null. */
async function runUnit(
	ctx: MutationCtx,
	entry: PlanEntry,
	row: Row,
	prog: Progress,
	runId: string,
): Promise<StepError | null> {
	const handle = entry.handle as StepHandle;
	const batchSize = batchSizeOf(entry, prog);
	const now = Date.now();
	try {
		if (entry.oneShot) {
			await ctx.runMutation(
				handle,
				{ step: entry.name, op: "run" },
				{
					transactionLimits: BATCH_LIMITS,
				},
			);
			await markRan(ctx, row, runId);
			return null;
		}
		if (prog.phase === "clear") {
			const r = (await ctx.runMutation(
				handle,
				{ step: entry.name, op: "clear", cursor: prog.cursor, batchSize },
				{ transactionLimits: BATCH_LIMITS },
			)) as ClearResult;
			await ctx.db.patch("progress", prog._id, {
				cursor: r.isDone ? null : r.cursor,
				phase: r.isDone ? "migrate" : "clear",
				// The backfill starts at its own size, not the one the clear ended on.
				...(r.isDone ? { batchSize: undefined } : {}),
				updatedAt: now,
			});
			return null;
		}
		if (prog.phase === "verify") {
			const r = (await ctx.runMutation(
				handle,
				{ step: entry.name, op: "verify", cursor: prog.cursor, batchSize },
				{ transactionLimits: BATCH_LIMITS },
			)) as VerifyResult;
			const notMigrated = (prog.notMigrated ?? 0) + r.notMigrated;
			const samples = [...(prog.samples ?? []), ...r.samples].slice(
				0,
				MAX_SAMPLES,
			);
			await ctx.db.patch("progress", prog._id, {
				cursor: r.cursor,
				notMigrated,
				samples,
				verified: r.isDone && notMigrated === 0 ? true : undefined,
				updatedAt: now,
			});
			if (!r.isDone) return null;
			if (notMigrated > 0) {
				const error = await markFailed(
					ctx,
					row,
					(await ctx.db.get("progress", prog._id))!,
					runId,
					`Verification found ${notMigrated} document(s) that still need this Migration after the last batch, for example ${samples.join(", ")}. ` +
						`Old code may still be writing the old shape. Run apply again to migrate them.`,
				);
				// The next apply scans the table again; `needs` skips what is done.
				// The count stays for status until the next verify pass starts.
				await ctx.db.patch("progress", prog._id, {
					phase: "migrate",
					cursor: null,
					verified: undefined,
				});
				return error;
			}
			await markRan(ctx, row, runId);
			return null;
		}
		const r = (await ctx.runMutation(
			handle,
			{ step: entry.name, op: "batch", cursor: prog.cursor, batchSize },
			{ transactionLimits: BATCH_LIMITS },
		)) as BatchResult;
		const grown =
			batchSize < entry.batchSize
				? Math.min(entry.batchSize, Math.ceil(batchSize * 1.2))
				: batchSize;
		const done = r.isDone;
		await ctx.db.patch("progress", prog._id, {
			cursor: done && entry.verify ? null : r.cursor,
			processed: prog.processed + r.processed,
			skipped: prog.skipped + r.skipped,
			batches: prog.batches + 1,
			batchSize: grown,
			updatedAt: now,
			...(done && entry.verify
				? { phase: "verify" as const, notMigrated: 0, samples: [] }
				: {}),
		});
		if (done && !entry.verify) await markRan(ctx, row, runId);
		return null;
	} catch (e) {
		const message = errorMessage(e);
		const limit = !(e instanceof ConvexError) && isLimitError(message);
		if (limit && batchSize > 1 && shrinkHelps(entry, prog)) {
			const smaller = Math.max(1, Math.floor(batchSize / 2));
			await ctx.db.patch("progress", prog._id, {
				batchSize: smaller,
				updatedAt: now,
			});
			await logEvent(
				ctx,
				row.name,
				"batch shrunk",
				runId,
				`${batchSize} -> ${smaller}: ${message}`,
			);
			return null;
		}
		return await markFailed(ctx, row, prog, runId, message);
	}
}

// The scheduler accepts at most five years ahead.
const SENTINEL_DELAY_MS = 4 * 365 * 24 * 60 * 60 * 1000;
// convex-test schedules with setTimeout, which fires at once and warns for a
// delay above 2^31 - 1 ms. `register` from convex-improved-migration/test
// sets this flag, so the sentinel stays pending in tests as on a deployment.
function sentinelDelay(): number {
	const short = (globalThis as Record<string, unknown>)[SHORT_SENTINEL_FLAG];
	return short ? 2 ** 31 - 1 : SENTINEL_DELAY_MS;
}

/** Fires only after years; records that it fired so that is not a restore. */
export const sentinel = internalMutation({
	args: { token: v.optional(v.string()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const meta = await ctx.db.query("meta").first();
		// A sentinel armed before a reset must not disarm the current one.
		if (meta && meta.token === args.token) {
			await ctx.db.patch("meta", meta._id, { sentinelFiredAt: Date.now() });
		}
		return null;
	},
});

/**
 * Read-only check: does the recorded sentinel point at a job that is gone or
 * canceled? Then this state came from a snapshot and no apply has run since.
 * A sentinel that fired, or is firing, is not a restore.
 */
async function restoreSuspected(ctx: QueryCtx): Promise<boolean> {
	const meta = await ctx.db.query("meta").first();
	if (!meta?.sentinelId || meta.sentinelFiredAt !== undefined) return false;
	const id = ctx.db.system.normalizeId("_scheduled_functions", meta.sentinelId);
	const job = id ? await ctx.db.system.get("_scheduled_functions", id) : null;
	return (
		job === null || job.state.kind === "canceled" || job.state.kind === "failed"
	);
}

/**
 * True when this state was restored from a snapshot since the last run.
 * Re-arms the sentinel on every run. Side effect: cancelling all scheduled
 * functions in the dashboard makes the next apply request every Rebuild.
 */
async function detectRestore(ctx: MutationCtx): Promise<boolean> {
	const meta = await ctx.db.query("meta").first();
	const restored = await restoreSuspected(ctx);
	if (meta?.sentinelId && meta.sentinelFiredAt === undefined && !restored) {
		// Cancel it, so a snapshot taken before this run points at a job that
		// is no longer pending, even when it is restored into this deployment.
		const id = ctx.db.system.normalizeId(
			"_scheduled_functions",
			meta.sentinelId,
		);
		const job = id ? await ctx.db.system.get("_scheduled_functions", id) : null;
		if (id && job?.state.kind === "pending") await ctx.scheduler.cancel(id);
	}
	const token = Math.random().toString(36).slice(2);
	const sentinelId: string = await ctx.scheduler.runAfter(
		sentinelDelay(),
		internal.lib.sentinel,
		{ token },
	);
	if (meta) await ctx.db.replace("meta", meta._id, { sentinelId, token });
	else await ctx.db.insert("meta", { sentinelId, token });
	return restored;
}

/** Never repeats, so a driver that lost the Lease cannot pass its check again. */
function uniqueHolder(mode: "background" | "foreground", runId: string) {
	return `${mode}:${runId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
function backgroundHolder(runId: string) {
	return uniqueHolder("background", runId);
}

/** Schedule a driver action and record its job, so the watchdog can see it. */
async function scheduleDrive(
	ctx: MutationCtx,
	plan: PlanEntry[],
	runId: string,
	holder: string,
	budgetMs: number,
	retries?: number,
) {
	const job: string = await ctx.scheduler.runAfter(0, internal.lib.drive, {
		plan,
		runId,
		holder,
		budgetMs,
		...(retries ? { retries } : {}),
	});
	const lease = await getLease(ctx);
	if (lease) {
		await ctx.db.patch("lease", lease._id, {
			driveJob: job,
			expiresAt: Date.now() + LEASE_TTL_MS,
		});
	}
}

async function launch(
	ctx: MutationCtx,
	plan: PlanEntry[],
	runId: string,
	holder: string,
	budgetMs: number,
	retries?: number,
) {
	await scheduleDrive(ctx, plan, runId, holder, budgetMs, retries);
	await ctx.scheduler.runAfter(LEASE_TTL_MS, internal.lib.watchdog, { runId });
}

/**
 * Check for unfinished Orphans and a snapshot restore, mark requested
 * Rebuilds, then take the Lease. "read" only reports Orphans. "background"
 * also schedules the driver and its watchdog.
 */
export const prepare = mutation({
	args: {
		plan: v.array(planEntryValidator),
		runId: v.string(),
		mode: v.union(
			v.literal("read"),
			v.literal("foreground"),
			v.literal("background"),
		),
		only: v.optional(v.string()),
		rebuild: v.optional(v.array(v.string())),
		budgetMs: v.optional(v.number()),
	},
	returns: v.object({
		unfinishedOrphans: v.array(
			v.object({ name: v.string(), state: stateValidator }),
		),
		restored: v.boolean(),
		holder: v.union(v.string(), v.null()),
	}),
	handler: async (ctx, args) => {
		const names = new Set(args.plan.map((e) => e.name));
		if (names.size !== args.plan.length) {
			throw new Error("Two Steps in the Plan share an id.");
		}
		const unfinishedOrphans = [];
		for await (const row of ctx.db.query("steps")) {
			if (!names.has(row.name) && row.state !== "done") {
				unfinishedOrphans.push({ name: row.name, state: row.state });
			}
		}
		if (args.mode === "read" || unfinishedOrphans.length > 0) {
			return { unfinishedOrphans, restored: false, holder: null };
		}
		const restored = await detectRestore(ctx);
		const requested = new Set(args.rebuild ?? []);
		for (const entry of args.plan) {
			if (entry.kind !== "rebuild") continue;
			if (!restored && !requested.has(entry.name)) continue;
			const row = await getRow(ctx, entry.name);
			if (row) {
				await ctx.db.patch("steps", row._id, {
					rebuildRequested: true,
					updatedAt: Date.now(),
				});
			}
			await logEvent(
				ctx,
				entry.name,
				"rebuild requested",
				args.runId,
				restored ? "snapshot restore detected" : "requested by apply",
			);
		}
		const plan = args.only
			? args.plan.filter((e) => e.name === args.only)
			: args.plan;
		const background = args.mode === "background";
		const holder = background ? backgroundHolder(args.runId) : args.runId;
		const budgetMs = args.budgetMs ?? 20 * 60 * 1000;
		const lease = await getLease(ctx);
		if (lease && lease.runId !== args.runId) {
			await endRun(ctx, lease.runId, {
				outcome: "taken over",
				by: args.runId,
			});
		}
		await ctx.db.insert("runs", {
			runId: args.runId,
			startedAt: Date.now(),
			...(args.only !== undefined ? { only: args.only } : {}),
		});
		const value = {
			holder,
			runId: args.runId,
			expiresAt: Date.now() + LEASE_TTL_MS,
			mode: args.mode,
			startedAt: Date.now(),
			ticks: 0,
			restored,
			...(args.only !== undefined ? { only: args.only } : {}),
			...(background ? { plan, budgetMs, restarts: 0, restartTicks: 0 } : {}),
		};
		if (lease) await ctx.db.replace("lease", lease._id, value);
		else await ctx.db.insert("lease", value);
		if (background) await launch(ctx, plan, args.runId, holder, budgetMs);
		return { unfinishedOrphans, restored, holder };
	},
});

async function getRun(ctx: MutationCtx, runId: string) {
	return await ctx.db
		.query("runs")
		.withIndex("by_runId", (q) => q.eq("runId", runId))
		.unique();
}

/** Record how a run ended. The first outcome stays. */
async function endRun(
	ctx: MutationCtx,
	runId: string,
	end: { outcome: RunOutcome; failure?: Failure; by?: string },
) {
	const run = await getRun(ctx, runId);
	if (run && run.outcome === undefined) {
		await ctx.db.patch("runs", run._id, { ...end, endedAt: Date.now() });
	}
}

/** True when `cancel` stopped this run: its Lease or its run record says so. */
async function wasCanceled(
	ctx: MutationCtx,
	lease: Doc<"lease"> | null,
	runId: string,
): Promise<boolean> {
	if (lease?.runId === runId && lease.holder === "canceled") return true;
	return (await getRun(ctx, runId))?.outcome === "canceled";
}

/**
 * An `apply` comes back for the run it handed to the background. It takes
 * the Lease under the same run id, so the run goes on where it is: Seeds that
 * ran in this run do not run again. Everything it reports comes from the
 * run's own record: an unknown run, a scope that differs from the run's
 * `only`, or how the run ended. A run without an outcome whose Lease is gone
 * ended without one, for example after a crash of the apply that held it.
 */
export const resume = mutation({
	args: { runId: v.string(), only: v.optional(v.string()) },
	returns: v.object({
		holder: v.union(v.string(), v.null()),
		restored: v.boolean(),
		/** Throttle retries in a row so far; the apply goes on counting. */
		retries: v.number(),
		/** No record of this run on this deployment. */
		unknown: v.optional(v.boolean()),
		/** Set when `only` differs from the run's: the run's `only`, or null for the whole Plan. */
		scope: v.optional(v.object({ only: v.union(v.string(), v.null()) })),
		/** The run is over. `outcome` is null when it ended without one. */
		ended: v.optional(
			v.object({
				outcome: v.union(runOutcomeValidator, v.null()),
				failure: v.optional(failureValidator),
				by: v.optional(v.string()),
			}),
		),
	}),
	handler: async (ctx, args) => {
		const none = { holder: null, restored: false, retries: 0 };
		const lease = await getLease(ctx);
		const run = await getRun(ctx, args.runId);
		const own = lease?.runId === args.runId ? lease : null;
		// A Lease without a record was taken before runs were recorded.
		if (!run && !own) return { ...none, unknown: true };
		const only = (run ? run.only : own!.only) ?? null;
		if (only !== (args.only ?? null)) return { ...none, scope: { only } };
		if (run?.outcome !== undefined) {
			return {
				...none,
				ended: { outcome: run.outcome, failure: run.failure, by: run.by },
			};
		}
		if (!own || own.holder === "canceled") {
			return {
				...none,
				ended: { outcome: own ? ("canceled" as const) : null },
			};
		}
		const holder = uniqueHolder("foreground", args.runId);
		await ctx.db.patch("lease", own._id, {
			holder,
			mode: "foreground",
			expiresAt: Date.now() + LEASE_TTL_MS,
			driveJob: undefined,
		});
		await logEvent(ctx, "(run)", "taken back", args.runId);
		return {
			holder,
			restored: own.restored ?? false,
			retries: own.throttleRetries ?? 0,
		};
	},
});

/** A foreground `apply` passed its budget: move the run to the background. */
export const handOff = mutation({
	args: {
		plan: v.array(planEntryValidator),
		runId: v.string(),
		holder: v.string(),
		budgetMs: v.number(),
		/** Waits on a throttle or conflict that no `advance` recorded. */
		throttled: v.optional(throttleValidator),
		/** Throttle retries in a row so far. */
		retries: v.optional(v.number()),
	},
	/** "canceled": a cancel came first. "lost": another run holds the Lease. */
	returns: v.union(
		v.literal("handed"),
		v.literal("canceled"),
		v.literal("lost"),
	),
	handler: async (ctx, args) => {
		const lease = await getLease(ctx);
		if (!lease || lease.holder !== args.holder) {
			return (await wasCanceled(ctx, lease, args.runId))
				? ("canceled" as const)
				: ("lost" as const);
		}
		if (args.throttled)
			await logThrottle(ctx, "(run)", args.runId, args.throttled);
		const holder = backgroundHolder(args.runId);
		await ctx.db.patch("lease", lease._id, {
			holder,
			mode: "background",
			expiresAt: Date.now() + LEASE_TTL_MS,
			plan: args.plan,
			budgetMs: args.budgetMs,
			// Watchdog restarts without progress count on across a lap that
			// made none.
			restarts: lease.ticks === lease.restartTicks ? (lease.restarts ?? 0) : 0,
			restartTicks: lease.ticks,
			throttleRetries: args.retries,
		});
		await logEvent(ctx, "(run)", "handed over", args.runId);
		await launch(
			ctx,
			args.plan,
			args.runId,
			holder,
			args.budgetMs,
			args.retries,
		);
		return "handed" as const;
	},
});

/**
 * The background driver: the same loop as a foreground `apply`. Past its
 * budget it schedules itself again and exits.
 */
export const drive = internalAction({
	args: {
		plan: v.array(planEntryValidator),
		runId: v.string(),
		holder: v.string(),
		budgetMs: v.number(),
		/** Throttle retries in a row that earlier drivers of this run made. */
		retries: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const { plan, runId, holder, budgetMs } = args;
		const outcome = await runLoop(
			{
				advance: (throttled) =>
					ctx.runMutation(api.lib.advance, { plan, runId, holder, throttled }),
				recordAbort: (message, throttled) =>
					ctx.runMutation(api.lib.recordAbort, {
						plan,
						runId,
						holder,
						message,
						throttled,
					}),
			},
			Date.now() + budgetMs,
			args.retries,
		);
		if (outcome.status === "budget") {
			await retryTransient(() =>
				ctx.runMutation(api.lib.continueDrive, {
					plan,
					runId,
					holder,
					budgetMs,
					throttled: outcome.throttled,
					retries: outcome.retries,
				}),
			);
			return null;
		}
		if (outcome.status !== "preempted") {
			await retryTransient(() =>
				ctx.runMutation(api.lib.release, { holder, runId }),
			);
		}
		return null;
	},
});

/** A driver passed its budget: schedule the next one, if it still holds the Lease. */
export const continueDrive = mutation({
	args: {
		plan: v.array(planEntryValidator),
		runId: v.string(),
		holder: v.string(),
		budgetMs: v.number(),
		/** Waits on a throttle or conflict that no `advance` recorded. */
		throttled: v.optional(throttleValidator),
		/** Throttle retries in a row so far. */
		retries: v.optional(v.number()),
	},
	returns: v.boolean(),
	handler: async (ctx, args): Promise<boolean> => {
		const lease = await getLease(ctx);
		if (!lease || lease.holder !== args.holder) return false;
		if (args.throttled)
			await logThrottle(ctx, "(run)", args.runId, args.throttled);
		await ctx.db.patch("lease", lease._id, { throttleRetries: args.retries });
		await scheduleDrive(
			ctx,
			args.plan,
			args.runId,
			args.holder,
			args.budgetMs,
			args.retries,
		);
		return true;
	},
});

/**
 * Scheduled actions run at most once, so a background driver can vanish (a
 * crash, a push, a backend restart). Scheduled mutations run exactly once.
 * The watchdog checks the driver's scheduled job. While the job is pending or
 * in progress the driver is alive, even if it waits in a queue or sleeps
 * through a write throttle, and nothing happens. When the job ended but the
 * run still holds the Lease, the driver died: the watchdog starts a new one
 * under a new holder, so the old one stops at its next `advance`. It gives
 * up after MAX_RESTARTS restarts in a row without a new unit of work.
 */
export const watchdog = internalMutation({
	args: { runId: v.string() },
	returns: v.null(),
	handler: async (ctx, args): Promise<null> => {
		const lease = await getLease(ctx);
		if (!lease || lease.runId !== args.runId || lease.mode !== "background")
			return null;
		if (lease.holder === "canceled") return null;
		const jobId = lease.driveJob
			? ctx.db.system.normalizeId("_scheduled_functions", lease.driveJob)
			: null;
		const job = jobId
			? await ctx.db.system.get("_scheduled_functions", jobId)
			: null;
		const alive =
			job !== null &&
			(job.state.kind === "pending" || job.state.kind === "inProgress");
		if (alive) {
			await ctx.scheduler.runAfter(LEASE_TTL_MS, internal.lib.watchdog, args);
			return null;
		}
		const restarts =
			lease.ticks === lease.restartTicks ? (lease.restarts ?? 0) + 1 : 1;
		if (
			restarts > MAX_RESTARTS ||
			!lease.plan ||
			lease.budgetMs === undefined
		) {
			await logEvent(
				ctx,
				"(run)",
				"stalled",
				args.runId,
				`${restarts - 1} restart(s) without progress`,
			);
			await endRun(ctx, args.runId, { outcome: "stalled" });
			await ctx.db.delete("lease", lease._id);
			return null;
		}
		const holder = backgroundHolder(args.runId);
		await ctx.db.patch("lease", lease._id, {
			holder,
			restarts,
			restartTicks: lease.ticks,
		});
		await logEvent(
			ctx,
			"(run)",
			"restarted",
			args.runId,
			`driver job ${job ? job.state.kind : "missing"}; restart ${restarts}`,
		);
		await scheduleDrive(
			ctx,
			lease.plan,
			args.runId,
			holder,
			lease.budgetMs,
			lease.throttleRetries,
		);
		await ctx.scheduler.runAfter(LEASE_TTL_MS, internal.lib.watchdog, args);
		return null;
	},
});

export const release = mutation({
	args: { holder: v.string(), runId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const lease = await getLease(ctx);
		if (!lease) return null;
		const mine =
			lease.holder === args.holder ||
			(lease.holder === "canceled" && lease.runId === args.runId);
		if (mine) await ctx.db.delete("lease", lease._id);
		return null;
	},
});

/**
 * Record a failure that aborted a whole `advance` call, so it could not be
 * caught inside it. Shrinks the Batch first when the error is a limit error.
 */
export const recordAbort = mutation({
	args: {
		plan: v.array(planEntryValidator),
		runId: v.string(),
		holder: v.string(),
		message: v.string(),
		/** Waits on a throttle or conflict that no `advance` recorded. */
		throttled: v.optional(throttleValidator),
	},
	returns: abortResultValidator,
	handler: async (ctx, args) => {
		const lease = await getLease(ctx);
		if (!lease || lease.holder !== args.holder) {
			const canceled = await wasCanceled(ctx, lease, args.runId);
			return {
				retry: false as const,
				stopped: canceled ? ("canceled" as const) : ("preempted" as const),
			};
		}
		if (args.throttled)
			await logThrottle(ctx, "(run)", args.runId, args.throttled);
		for (const [i, entry] of args.plan.entries()) {
			const row = await getRow(ctx, entry.name);
			if (needs(entry, row, args.runId) === "skip") continue;
			const later = args.plan.slice(i + 1).map((e) => e.name);
			const running = await startRow(ctx, entry, row, args.runId);
			const size = batchSizeOf(entry, running.prog);
			const message = cleanError(args.message);
			if (
				isLimitError(message) &&
				size > 1 &&
				shrinkHelps(entry, running.prog)
			) {
				const smaller = Math.max(1, Math.floor(size / 2));
				await ctx.db.patch("progress", running.prog._id, {
					batchSize: smaller,
				});
				await logEvent(
					ctx,
					entry.name,
					"batch shrunk",
					args.runId,
					`${size} -> ${smaller}: ${message}`,
				);
				return { retry: true as const };
			}
			const error = await markFailed(
				ctx,
				running.row,
				running.prog,
				args.runId,
				message,
			);
			const failure = { name: entry.name, kind: entry.kind, error, later };
			await endRun(ctx, args.runId, { outcome: "failed", failure });
			return { retry: false as const, failure };
		}
		return { retry: false as const, failure: null };
	},
});

/**
 * Stop the active run at the next Batch boundary. The running Step goes back
 * to pending and keeps its cursor, so the next apply resumes it.
 */
export const cancel = mutation({
	// `runId`: stop only this run. Without it, stop whatever run holds the
	// Lease.
	args: { runId: v.optional(v.string()) },
	returns: v.union(
		v.string(),
		v.null(),
		v.object({ other: v.string() }),
		v.object({ ended: v.literal(true) }),
	),
	handler: async (ctx, args) => {
		// The run the caller named has nothing left to stop.
		const ended = args.runId === undefined ? null : { ended: true as const };
		const lease = await getLease(ctx);
		if (!lease) return ended;
		if (lease.holder === "canceled") {
			// No driver came back to see the cancel. Drop the leftover Lease.
			if (lease.expiresAt <= Date.now())
				await ctx.db.delete("lease", lease._id);
			return ended;
		}
		// The run the caller saw ended and a newer one took the Lease.
		if (args.runId !== undefined && lease.runId !== args.runId)
			return { other: lease.runId };
		// A driver that is still there stops at its next `advance` and releases
		// the Lease. When no driver is left to do that, drop the Lease here.
		let driverGone = lease.expiresAt <= Date.now();
		if (!driverGone && lease.mode === "background") {
			const jobId = lease.driveJob
				? ctx.db.system.normalizeId("_scheduled_functions", lease.driveJob)
				: null;
			const job = jobId
				? await ctx.db.system.get("_scheduled_functions", jobId)
				: null;
			driverGone =
				job === null ||
				(job.state.kind !== "pending" && job.state.kind !== "inProgress");
		}
		if (driverGone) await ctx.db.delete("lease", lease._id);
		else {
			await ctx.db.patch("lease", lease._id, {
				holder: "canceled",
				expiresAt: Date.now() + LEASE_TTL_MS,
			});
		}
		await logEvent(ctx, "(run)", "canceled", lease.runId);
		await endRun(ctx, lease.runId, { outcome: "canceled" });
		let canceled: string | null = null;
		for await (const row of ctx.db.query("steps")) {
			if (row.state === "running" && row.runId === lease.runId) {
				await ctx.db.patch("steps", row._id, {
					state: "pending",
					updatedAt: Date.now(),
				});
				await logEvent(ctx, row.name, "canceled", lease.runId);
				canceled = row.name;
			}
		}
		return canceled;
	},
});

const rowView = v.object({
	name: v.string(),
	kind: kindValidator,
	state: stateValidator,
	via: v.union(viaValidator, v.null()),
	version: v.union(v.string(), v.null()),
	rebuildRequested: v.boolean(),
	error: v.union(stepErrorValidator, v.null()),
	reason: v.union(v.string(), v.null()),
	runId: v.union(v.string(), v.null()),
	startedAt: v.union(v.number(), v.null()),
	doneAt: v.union(v.number(), v.null()),
	updatedAt: v.number(),
	phase: v.union(phaseValidator, v.null()),
	processed: v.number(),
	skipped: v.number(),
	batches: v.number(),
	batchSize: v.union(v.number(), v.null()),
	notMigrated: v.union(v.number(), v.null()),
	cursor: v.union(v.string(), v.null()),
	verified: v.union(v.boolean(), v.null()),
});

function view(row: Row, prog: Progress | null) {
	return {
		name: row.name,
		kind: row.kind,
		state: row.state,
		via: row.via ?? null,
		version: row.version ?? null,
		rebuildRequested: row.rebuildRequested ?? false,
		error: row.error ?? null,
		reason: row.reason ?? null,
		runId: row.runId ?? null,
		startedAt: row.startedAt ?? null,
		doneAt: row.doneAt ?? null,
		updatedAt: row.updatedAt,
		phase: prog?.phase ?? null,
		processed: prog?.processed ?? 0,
		skipped: prog?.skipped ?? 0,
		batches: prog?.batches ?? 0,
		batchSize: prog?.batchSize ?? null,
		notMigrated: prog?.notMigrated ?? null,
		cursor: prog?.cursor ?? null,
		verified: prog?.verified ?? null,
	};
}

/** Every recorded Step with its progress, plus the Lease. */
export const status = query({
	args: { eventsFor: v.optional(v.string()) },
	returns: v.object({
		/** A snapshot import happened and no apply has run since. */
		restoreSuspected: v.boolean(),
		rows: v.array(rowView),
		lease: v.union(
			v.object({
				holder: v.string(),
				runId: v.string(),
				mode: v.union(v.literal("foreground"), v.literal("background")),
				startedAt: v.number(),
				expiresAt: v.number(),
			}),
			v.null(),
		),
		events: v.array(
			v.object({
				type: v.string(),
				at: v.number(),
				runId: v.union(v.string(), v.null()),
				detail: v.union(v.string(), v.null()),
			}),
		),
	}),
	handler: async (ctx, args) => {
		const progress = new Map<string, Progress>();
		for await (const p of ctx.db.query("progress")) progress.set(p.name, p);
		const rows = [];
		for await (const row of ctx.db.query("steps")) {
			rows.push(view(row, progress.get(row.name) ?? null));
		}
		const lease = await ctx.db.query("lease").first();
		const events = args.eventsFor
			? (
					await ctx.db
						.query("events")
						.withIndex("by_name", (q) => q.eq("name", args.eventsFor!))
						.order("desc")
						.take(20)
				).map((e) => ({
					type: e.type,
					at: e.at,
					runId: e.runId ?? null,
					detail: e.detail ?? null,
				}))
			: [];
		return {
			restoreSuspected: await restoreSuspected(ctx),
			rows,
			lease: lease
				? {
						holder: lease.holder,
						runId: lease.runId,
						mode: lease.mode,
						startedAt: lease.startedAt,
						expiresAt: lease.expiresAt,
					}
				: null,
			events,
		};
	},
});

/**
 * Readiness: true when the Step is Done and, for a Rebuild, built for this
 * Version with no rebuild pending and no snapshot import since the last
 * apply. A Seed stays Ready after its first success. Reads one `steps` row,
 * which changes only on state transitions.
 */
export const isReady = query({
	args: { name: v.string(), version: v.optional(v.string()) },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("steps")
			.withIndex("by_name", (q) => q.eq("name", args.name))
			.unique();
		if (!row) return false;
		if (row.kind === "seed") return row.doneAt !== undefined;
		if (row.state !== "done" || row.rebuildRequested) return false;
		if (row.kind !== "rebuild") return true;
		if (args.version !== undefined && row.version !== args.version)
			return false;
		// Derived data is stale after a snapshot import until apply rebuilds it.
		// Only Rebuilds pay for these two extra reads. They change once per
		// apply, not per Batch.
		return !(await restoreSuspected(ctx));
	},
});

export const markDone = mutation({
	args: {
		name: v.string(),
		kind: kindValidator,
		version: v.optional(v.string()),
		reason: v.string(),
	},
	returns: v.union(
		v.literal("ok"),
		v.literal("running"),
		v.literal("done"),
		v.literal("import"),
	),
	handler: async (ctx, args) => {
		const now = Date.now();
		const row = await getRow(ctx, args.name);
		if (await isBeingRun(ctx, row)) return "running" as const;
		// Decided here, in the transaction that writes, so a run that finishes
		// the Step meanwhile keeps its "via ran" and its counts. A Rebuild that
		// apply would start over is not done in that sense and may be marked.
		const importSuspected = await restoreSuspected(ctx);
		// The next apply rebuilds every Rebuild after an import, so a mark
		// would not hold.
		if (args.kind === "rebuild" && importSuspected) return "import" as const;
		if (row?.state === "done") {
			const { why } = startOver(args, row, false, { importSuspected });
			if (why === null || why === "rebuild") return "done" as const;
		}
		const fields = {
			state: "done" as const,
			via: "marked" as const,
			reason: args.reason,
			error: undefined,
			rebuildRequested: false,
			version: args.version,
			doneAt: now,
			updatedAt: now,
			// No run changed this row.
			runId: undefined,
			startedAt: undefined,
		};
		if (row) await ctx.db.patch("steps", row._id, fields);
		else
			await ctx.db.insert("steps", {
				...fields,
				name: args.name,
				kind: args.kind,
			});
		const prog = await getProgress(ctx, args.name);
		if (prog) await ctx.db.delete("progress", prog._id);
		await logEvent(
			ctx,
			args.name,
			"done",
			undefined,
			`via marked: ${args.reason}`,
		);
		return "ok" as const;
	},
});

export const reset = mutation({
	args: { name: v.string() },
	returns: v.union(v.literal("ok"), v.literal("missing"), v.literal("running")),
	handler: async (ctx, args) => {
		const row = await getRow(ctx, args.name);
		if (!row) return "missing" as const;
		if (await isBeingRun(ctx, row)) return "running" as const;
		const prog = await getProgress(ctx, args.name);
		const detail = history(row, prog);
		await ctx.db.patch("steps", row._id, {
			state: "pending",
			via: undefined,
			error: undefined,
			reason: undefined,
			doneAt: undefined,
			runId: undefined,
			startedAt: undefined,
			updatedAt: Date.now(),
		});
		if (prog) await ctx.db.delete("progress", prog._id);
		await logEvent(ctx, args.name, "reset", undefined, detail);
		return "ok" as const;
	},
});

/** Record upstream `@convex-dev/migrations` Done names as Done via adopted. */
export const adopt = mutation({
	args: { names: v.array(v.string()) },
	returns: v.object({
		adopted: v.number(),
		alreadyDone: v.number(),
		/** Steps a live run is working on. When not empty, nothing was recorded. */
		running: v.array(v.string()),
	}),
	handler: async (ctx, args) => {
		let adopted = 0;
		let alreadyDone = 0;
		const now = Date.now();
		const running: string[] = [];
		for (const name of args.names) {
			if (await isBeingRun(ctx, await getRow(ctx, name))) running.push(name);
		}
		if (running.length) return { adopted, alreadyDone, running };
		for (const name of args.names) {
			const row = await getRow(ctx, name);
			if (row?.state === "done") {
				alreadyDone++;
				continue;
			}
			const fields = {
				state: "done" as const,
				via: "adopted" as const,
				reason: "adopted from @convex-dev/migrations",
				doneAt: now,
				updatedAt: now,
			};
			if (row) {
				// A failed or interrupted attempt here must not show beside Done.
				await ctx.db.patch("steps", row._id, {
					...fields,
					error: undefined,
					runId: undefined,
					startedAt: undefined,
				});
				const prog = await getProgress(ctx, name);
				if (prog) await ctx.db.delete("progress", prog._id);
			} else {
				await ctx.db.insert("steps", { ...fields, name, kind: "migration" });
			}
			await logEvent(ctx, name, "done", undefined, "via adopted");
			adopted++;
		}
		return { adopted, alreadyDone, running };
	},
});
