import { defineMigrations } from "convex-improved-migration";
import { components } from "./_generated/api";
import schema from "./schema";

const COUNTRIES = [
	{ code: "CN", name: "China" },
	{ code: "DE", name: "Germany" },
];

const m = defineMigrations(components.migration, { schema });

export const migrations = m.plan([
	// Runs on every apply. Idempotent upsert, also callable from a dev seed.
	m.seed("countries", async (ctx) => {
		for (const c of COUNTRIES) {
			const existing = await ctx.db
				.query("countries")
				.withIndex("by_code", (q) => q.eq("code", c.code))
				.unique();
			if (!existing) await ctx.db.insert("countries", c);
		}
	}),

	// Runs once per deployment, batch by batch, then stays Done.
	m.migrate("2026-11-10-user-role", {
		table: "users",
		needs: (u) => u.role === undefined,
		run: (_ctx, u) => {
			if (u.name === "poison") throw new Error(`cannot migrate user ${u._id}`);
			if (u.name === "limit-bomb")
				throw new Error(
					"Too many documents read in a single function execution (limit: 32000)",
				);
			return { role: "member" };
		},
	}),

	// A Migration without a table: one mutation, once per deployment.
	m.once("2026-11-10-grant-admin-export", async (ctx) => {
		const existing = await ctx.db
			.query("grants")
			.withIndex("by_role_and_permission", (q) =>
				q.eq("role", "admin").eq("permission", "export"),
			)
			.unique();
		if (!existing) {
			await ctx.db.insert("grants", { role: "admin", permission: "export" });
		}
	}),

	// Recomputes derived data when its version changes, or on `rebuild`.
	m.rebuild("request-counters", {
		version: 1,
		table: "requests",
		clear: "requestCounters",
		run: async (ctx, r) => {
			const counter = await ctx.db
				.query("requestCounters")
				.withIndex("by_userId", (q) => q.eq("userId", r.userId))
				.unique();
			if (counter) {
				await ctx.db.patch("requestCounters", counter._id, {
					count: counter.count + 1,
				});
			} else {
				await ctx.db.insert("requestCounters", { userId: r.userId, count: 1 });
			}
		},
	}),
]);

export const { apply, status, operate, runStep } = migrations.functions;
