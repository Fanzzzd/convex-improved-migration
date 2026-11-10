import { v } from "convex/values";
import {
	internalAction,
	internalMutation,
	internalQuery,
} from "./_generated/server";

export const addItems = internalMutation({
	args: { from: v.number(), count: v.number(), payloadKb: v.number() },
	handler: async (ctx, args) => {
		const payload = "x".repeat(args.payloadKb * 1024);
		for (let i = 0; i < args.count; i++) {
			await ctx.db.insert("items", {
				n: args.from + i,
				payload: args.payloadKb ? payload : undefined,
			});
		}
		return null;
	},
});

export const setFlag = internalMutation({
	args: { name: v.string(), on: v.boolean() },
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("flags")
			.withIndex("by_name", (q) => q.eq("name", args.name))
			.unique();
		if (row) await ctx.db.patch("flags", row._id, { on: args.on });
		else await ctx.db.insert("flags", args);
		return null;
	},
});

export const counts = internalQuery({
	args: {},
	handler: async (ctx) => {
		let touched = 0;
		let total = 0;
		let withPayload = 0;
		for await (const i of ctx.db.query("items")) {
			total++;
			if (i.touched) touched++;
			if (i.payload !== undefined) withPayload++;
		}
		const counter = await ctx.db.query("itemCount").first();
		return { total, touched, withPayload, itemCount: counter?.count ?? null };
	},
});

export const seedRuns = internalQuery({
	args: { name: v.string() },
	handler: async (ctx, args) => {
		const rows = await ctx.db.query("seedRuns").take(1000);
		return rows.filter((r) => r.name === args.name).length;
	},
});

export const wipe = internalMutation({
	args: {
		table: v.union(
			v.literal("items"),
			v.literal("itemCount"),
			v.literal("flags"),
		),
	},
	handler: async (ctx, args) => {
		const docs = await ctx.db.query(args.table).take(200);
		for (const d of docs) await ctx.db.delete(args.table, d._id);
		return docs.length;
	},
});

// Reads only the counter. `counts` reads every item and fails while items
// carry 150 KB payloads (120 x 150 KB is over the 16 MiB read limit).
export const itemCount = internalQuery({
	args: {},
	handler: async (ctx) => {
		const counter = await ctx.db.query("itemCount").first();
		return counter?.count ?? null;
	},
});

// Mark some items as not touched, so "touch-items" processes them again
// after a reset. Uses the index because a full scan is over the read limit.
export const untouch = internalMutation({
	args: {
		ns: v.optional(v.array(v.number())),
		from: v.optional(v.number()),
		to: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const ns = args.ns ?? [];
		for (let n = args.from ?? 0; n < (args.to ?? 0); n++) ns.push(n);
		for (const n of ns) {
			const item = await ctx.db
				.query("items")
				.withIndex("by_n", (q) => q.eq("n", n))
				.unique();
			if (item) await ctx.db.patch("items", item._id, { touched: false });
		}
		return null;
	},
});

// Probe: can an action wait on a timer? The driver's throttle backoff needs it.
export const timer = internalAction({
	args: { ms: v.number() },
	handler: async (_ctx, args) => {
		const t0 = Date.now();
		await new Promise((resolve) => setTimeout(resolve, args.ms));
		return Date.now() - t0;
	},
});
