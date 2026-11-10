// A Plan with a tiny time budget, to check the Still Running handoff and
// an apply that comes back for the same run.
import { defineMigrations } from "convex-improved-migration";
import { components } from "./_generated/api";
import schema from "./schema";

const m = defineMigrations(components.migration, {
	schema,
	module: "slow",
	budgetMs: 1,
});

export const { apply, status, operate, runStep } = m.plan([
	// One row per run of this Seed, so the script can count the runs.
	m.seed("slow-seed", async (ctx) => {
		await ctx.db.insert("seedRuns", { name: "slow-seed" });
	}),
	m.migrate("slow-untouch", {
		table: "items",
		batchSize: 5,
		needs: (i) => i.payload !== undefined,
		run: () => ({ payload: undefined }),
	}),
]).functions;
