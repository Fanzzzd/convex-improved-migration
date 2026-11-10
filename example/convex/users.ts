import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { migrations } from "./migrations";

/** A reader gated on Readiness: the legacy path until the backfill is Done. */
export const roleOf = query({
	args: { id: v.id("users") },
	handler: async (ctx, args) => {
		const user = await ctx.db.get("users", args.id);
		if (!user) return null;
		if (await migrations.isReady(ctx, "2026-11-10-user-role"))
			return user.role!;
		return user.role ?? "member";
	},
});

export const addMany = internalMutation({
	args: { names: v.array(v.string()), role: v.optional(v.literal("member")) },
	handler: async (ctx, args) => {
		const ids = [];
		for (const name of args.names) {
			ids.push(await ctx.db.insert("users", { name, role: args.role }));
		}
		return ids;
	},
});
