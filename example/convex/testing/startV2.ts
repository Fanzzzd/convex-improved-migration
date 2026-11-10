// Test-only: one Rebuild and one Migration that a test can stop part way
// (budgetMs 0). startV1 and startV2 differ only in the Rebuild's version, so
// a test can bump it. Both must decide "resume or start over" like apply.
import { defineMigrations } from "convex-improved-migration";
import { components } from "../_generated/api";
import schema from "../schema";

const m = defineMigrations(components.migration, {
	schema,
	module: "testing/startV2",
	budgetMs: 0,
});

export const startV2 = m.plan([
	m.rebuild("start-counters", {
		version: 2,
		table: "requests",
		clear: "requestCounters",
		batchSize: 2,
		run: async (ctx, r) => {
			if (r.amount < 0) throw new Error(`negative amount in ${r._id}`);
			await ctx.db.insert("requestCounters", { userId: r.userId, count: 1 });
		},
	}),
	m.migrate("start-member", {
		table: "users",
		batchSize: 2,
		run: (_ctx, u) => {
			if (u.name === "poison") throw new Error(`cannot migrate user ${u._id}`);
			return { role: "member" };
		},
	}),
]);

export const { apply, status, operate, runStep } = startV2.functions;
