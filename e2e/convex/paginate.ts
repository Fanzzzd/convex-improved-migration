// A Plan whose Steps call .paginate(). convex-test allows one paginated
// query per function; this checks that a real backend accepts more in a
// mutation.
import { defineMigrations } from "convex-improved-migration";
import { components } from "./_generated/api";
import schema from "./schema";

const m = defineMigrations(components.migration, {
	schema,
	module: "paginate",
});

export const { apply, status, operate, runStep } = m.plan([
	// In a Dry Run this `clear` and the first Batch share one transaction.
	m.rebuild("clear-paginates", {
		version: 1,
		table: "flags",
		clear: async (ctx) => {
			const { page } = await ctx.db
				.query("itemCount")
				.paginate({ numItems: 10, cursor: null });
			for (const row of page) await ctx.db.delete("itemCount", row._id);
		},
		run: async (ctx) => {
			const row = await ctx.db.query("itemCount").first();
			if (row)
				await ctx.db.patch("itemCount", row._id, { count: row.count + 1 });
			else await ctx.db.insert("itemCount", { count: 1 });
		},
	}),
	// `run` shares its transaction with the Batch's own paginated query.
	m.migrate("run-paginates", {
		table: "flags",
		run: async (ctx) => {
			await ctx.db.query("itemCount").paginate({ numItems: 1, cursor: null });
		},
	}),
]).functions;
