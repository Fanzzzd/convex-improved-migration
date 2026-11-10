import { defineMigrations } from "convex-improved-migration";
import { components } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";

async function flag(ctx: MutationCtx, name: string) {
	const row = await ctx.db
		.query("flags")
		.withIndex("by_name", (q) => q.eq("name", name))
		.unique();
	return row?.on ?? false;
}

const m = defineMigrations(components.migration, { schema });

export const migrations = m.plan([
	// Heavy documents: a batch of 100 reads more than the nested byte limit,
	// so the batch must shrink on a real backend.
	m.migrate("touch-items", {
		table: "items",
		needs: (i) => i.touched !== true,
		run: async (ctx, i) => {
			if (i.n === 7 && (await flag(ctx, "fail"))) {
				throw new Error(`refusing item ${i.n} while the fail flag is on`);
			}
			if (i.n === 8 && (await flag(ctx, "slow"))) {
				// Burn more than the 1 s user-code limit.
				let x = 0;
				for (let k = 0; k < 4e9; k++) x += k;
				return { touched: x > 0 };
			}
			if (await flag(ctx, "lag")) {
				// A few ms of work per document, so one driver action runs for
				// seconds. Date.now() is frozen inside a mutation, so count instead.
				let x = 0;
				for (let k = 0; k < 2e6; k++) x += k;
				return { touched: x > 0 };
			}
			return { touched: true };
		},
	}),
	m.rebuild("item-count", {
		version: 1,
		table: "items",
		clear: "itemCount",
		batchSize: 50,
		run: async (ctx) => {
			const row = await ctx.db.query("itemCount").first();
			if (row)
				await ctx.db.patch("itemCount", row._id, { count: row.count + 1 });
			else await ctx.db.insert("itemCount", { count: 1 });
		},
	}),
]);

export const { apply, status, operate, runStep } = migrations.functions;
