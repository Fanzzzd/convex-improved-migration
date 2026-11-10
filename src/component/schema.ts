import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
	failureValidator,
	kindValidator,
	phaseValidator,
	planEntryValidator,
	runOutcomeValidator,
	stateValidator,
	stepErrorValidator,
	viaValidator,
} from "../shared.js";

export default defineSchema({
	/**
	 * State of each Step on this deployment. One row per Step id. Written only
	 * on state transitions, so Readiness queries do not re-run on every Batch.
	 */
	steps: defineTable({
		name: v.string(),
		kind: kindValidator,
		state: stateValidator,
		via: v.optional(viaValidator),
		/** Rebuild: the Version this row was built (or is being built) for. */
		version: v.optional(v.string()),
		rebuildRequested: v.optional(v.boolean()),
		error: v.optional(stepErrorValidator),
		reason: v.optional(v.string()),
		/** The run that last changed this row's state. */
		runId: v.optional(v.string()),
		startedAt: v.optional(v.number()),
		doneAt: v.optional(v.number()),
		updatedAt: v.number(),
	}).index("by_name", ["name"]),

	/** Where each Step's scan stands. Written on every Batch. */
	progress: defineTable({
		name: v.string(),
		phase: v.optional(phaseValidator),
		cursor: v.union(v.string(), v.null()),
		processed: v.number(),
		skipped: v.number(),
		batches: v.number(),
		batchSize: v.optional(v.number()),
		notMigrated: v.optional(v.number()),
		samples: v.optional(v.array(v.string())),
		verified: v.optional(v.boolean()),
		updatedAt: v.number(),
	}).index("by_name", ["name"]),

	/** Append-only history of what happened to each Step. */
	events: defineTable({
		name: v.string(),
		type: v.string(),
		at: v.number(),
		runId: v.optional(v.string()),
		detail: v.optional(v.string()),
	}).index("by_name", ["name"]),

	/**
	 * One row per run that took the Lease: its scope, and how it ended once
	 * it did. `resume` reports a run from this record, not from the Steps,
	 * which later runs and operator commands change.
	 */
	runs: defineTable({
		runId: v.string(),
		/** The one Step the run was started for with `only`. */
		only: v.optional(v.string()),
		startedAt: v.number(),
		outcome: v.optional(runOutcomeValidator),
		/** The failure that ended the run. */
		failure: v.optional(failureValidator),
		/** The run that took the Lease over. */
		by: v.optional(v.string()),
		endedAt: v.optional(v.number()),
	}).index("by_runId", ["runId"]),

	/**
	 * At most one row. The sentinel is a scheduled function far in the future.
	 * Backups and snapshot imports do not restore pending scheduled functions,
	 * so a recorded sentinel that no longer exists means this state was
	 * restored from a snapshot, and Rebuilds must run again.
	 */
	meta: defineTable({
		sentinelId: v.union(v.string(), v.null()),
		token: v.optional(v.string()),
		sentinelFiredAt: v.optional(v.number()),
	}),

	/** At most one row: which driver may run Batches right now. */
	lease: defineTable({
		holder: v.string(),
		runId: v.string(),
		expiresAt: v.number(),
		mode: v.union(v.literal("foreground"), v.literal("background")),
		startedAt: v.number(),
		/** The one Step the run was started for with `only`. */
		only: v.optional(v.string()),
		/**
		 * Throttle retries in a row that the run's Drivers made, stored at a
		 * handover so the next Driver, a watchdog restart or a resume goes on
		 * counting. A unit that goes through clears it.
		 */
		throttleRetries: v.optional(v.number()),
		/**
		 * Counts Lease renewals by a driver that did work. The watchdog reads a
		 * change as progress.
		 */
		ticks: v.number(),
		/** Background only: what the watchdog needs to restart the driver. */
		plan: v.optional(v.array(planEntryValidator)),
		budgetMs: v.optional(v.number()),
		restarts: v.optional(v.number()),
		restartTicks: v.optional(v.number()),
		/** Background only: the scheduled job of the current driver action. */
		driveJob: v.optional(v.string()),
		/** This run began after a snapshot import. Kept for an apply that comes back. */
		restored: v.optional(v.boolean()),
	}),
});
