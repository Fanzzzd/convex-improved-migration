// Test-only: a Plan whose foreground apply does one unit of work, then hands
// the run to the background (budgetMs 0). A caller that comes back with
// `resume` goes on with the same run.
import { defineMigrations } from "convex-improved-migration";
import { components } from "../_generated/api";
import schema from "../schema";

const m = defineMigrations(components.migration, {
	schema,
	module: "testing/laps",
	budgetMs: 0,
});

export const laps = m.plan([
	// Not idempotent on purpose: every run of this Seed leaves one row, so a
	// test can count the runs.
	m.seed("laps-seed", async (ctx) => {
		await ctx.db.insert("grants", {
			role: "laps-seed-run",
			permission: String(Date.now()),
		});
	}),
	m.migrate("laps-role", {
		table: "users",
		batchSize: 10,
		run: (_ctx, u) => {
			if (u.name === "poison") throw new Error(`cannot migrate user ${u._id}`);
			return { role: "member" };
		},
	}),
]);

export const { apply, status, operate, runStep } = laps.functions;
