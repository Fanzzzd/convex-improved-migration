// Test-only: Steps that reproduce bugs fixed earlier. Tests run each one
// with `only`, because a failed Step stops the rest of the Plan.
import { ConvexError } from "convex/values";
import { defineMigrations } from "convex-improved-migration";
import { components } from "../_generated/api";
import schema from "../schema";

const m = defineMigrations(components.migration, {
	schema,
	module: "testing/regressions",
});

export const regressions = m.plan([
	// Writes the role only once a grant exists, so the first verify pass fails.
	m.migrate("verify-me", {
		table: "users",
		needs: (u) => u.role === undefined,
		run: async (ctx) =>
			(await ctx.db.query("grants").first()) ? { role: "member" } : undefined,
	}),
	// A limit-looking error in a Seed must fail, not loop.
	m.seed("limit-seed", () => {
		throw new Error(
			"Too many documents read in a single function execution (limit: 32000)",
		);
	}),
	// User errors that mention a limit must fail without halving the Batch.
	m.migrate("user-limit-error", {
		table: "users",
		run: () => {
			throw new Error("value exceeds the credit limit");
		},
	}),
	m.migrate("user-convex-error", {
		table: "users",
		run: () => {
			throw new ConvexError(
				"Too many documents read in a single function execution",
			);
		},
	}),
	// Removes a field, for the Dry Run "<unset>" marker.
	m.migrate("unset-role", {
		table: "users",
		run: () => ({ role: undefined }),
	}),
	// Lets a test move its fake clock forward inside a Batch, to pass the
	// foreground budget without waiting.
	m.migrate("slow-clock", {
		table: "users",
		batchSize: 1,
		run: () => {
			(globalThis as { advanceTestClock?: () => void }).advanceTestClock?.();
		},
	}),
	// `run` paginates. convex-test allows one paginated query per function
	// and the Batch already ran it. A deployed backend accepts this.
	m.migrate("run-paginates", {
		table: "users",
		run: async (ctx) => {
			await ctx.db.query("grants").paginate({ numItems: 1, cursor: null });
		},
	}),
	// A `clear` function runs in its own transaction, so it may paginate.
	m.rebuild("clear-paginates", {
		version: 1,
		table: "requests",
		clear: async (ctx) => {
			const { page } = await ctx.db
				.query("requestCounters")
				.paginate({ numItems: 100, cursor: null });
			for (const counter of page)
				await ctx.db.delete("requestCounters", counter._id);
		},
		run: async (ctx, request) => {
			await ctx.db.insert("requestCounters", {
				userId: request.userId,
				count: 1,
			});
		},
	}),
]);

export const { apply, status, operate, runStep } = regressions.functions;
