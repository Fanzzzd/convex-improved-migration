// A Plan that runs for more than five minutes, for E2E_LONG=1. `convex run`
// drops a call after 300 s, so the command line program has to wait for
// this run over several apply calls. The run's length comes from the clock,
// not from CPU work, so it is the same on a fast and on a busy machine.
import { defineMigrations } from "convex-improved-migration";
import { components } from "./_generated/api";
import schema from "./schema";

/** How long the crawl keeps adding ticks after the first one. */
const LONG_MS = 310_000;

const m = defineMigrations(components.migration, { schema, module: "long" });

export const { apply, status, operate, runStep } = m.plan([
	// One row per run of this Seed, so the script can count the runs. It also
	// writes the first tick, with the time the crawl measures from.
	m.seed("long-seed", async (ctx) => {
		await ctx.db.insert("seedRuns", { name: "long-seed" });
		await ctx.db.insert("ticks", { startedAt: Date.now() });
	}),
	// One tick per Batch. Each tick adds the next one at the end of the table
	// until LONG_MS has passed. Date.now() in a mutation is its start time, so
	// it moves on from one Batch to the next. No `needs`: a verify pass would
	// scan every tick again, one per Batch.
	m.migrate("long-crawl", {
		table: "ticks",
		batchSize: 1,
		run: async (ctx, tick) => {
			if (Date.now() - tick.startedAt < LONG_MS) {
				await ctx.db.insert("ticks", { startedAt: tick.startedAt });
			}
			return { done: true };
		},
	}),
]).functions;
