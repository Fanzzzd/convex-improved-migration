// Test-only: a Plan whose foreground apply does one unit of work, then hands
// the run to the background (budgetMs 0). Its Rebuild clears a table first,
// so a test can stop a run during the clear, before any Batch.
import { defineMigrations } from "convex-improved-migration";
import { components } from "../_generated/api";
import schema from "../schema";

const m = defineMigrations(components.migration, {
	schema,
	module: "testing/rebuildLaps",
	budgetMs: 0,
});

export const rebuildLaps = m.plan([
	m.rebuild("laps-counters", {
		version: 1,
		table: "requests",
		clear: "requestCounters",
		batchSize: 10,
		run: async (ctx, r) => {
			if (r.amount < 0) throw new Error(`negative amount in ${r._id}`);
			await ctx.db.insert("requestCounters", { userId: r.userId, count: 1 });
		},
	}),
	m.migrate("laps-member", {
		table: "users",
		batchSize: 10,
		run: () => ({ role: "member" }),
	}),
]);

export const { apply, status, operate, runStep } = rebuildLaps.functions;
