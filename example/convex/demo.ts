// Public functions for the example page (`npm run dev:frontend`).
//
// `apply`, `status`, `operate` and `runStep` stay internal. These wrappers
// expose only what the page needs, with no auth, for a local demo. A real app
// must check who is calling before it starts a run, and before a public query
// such as `overview` returns the Plan's status, which can contain error text
// from the Steps.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { migrations } from "./migrations";

const ROLE = "2026-11-10-user-role";

/** The Plan's state and the newest users, read through the Readiness gate. */
export const overview = query({
	args: {},
	handler: async (ctx) => {
		const status = await migrations.status(ctx);
		const roleReady = await migrations.isReady(ctx, ROLE);
		const users = await ctx.db.query("users").order("desc").take(8);
		return {
			state: status.state,
			running: status.run !== null,
			importSuspected: status.importSuspected,
			steps: status.steps.map((s) => ({
				id: s.id,
				kind: s.kind,
				state: s.state,
				processed: s.processed,
				skipped: s.skipped,
				reason: s.reason ?? s.error?.message ?? null,
			})),
			roleReady,
			users: users.map((u) => ({
				_id: u._id,
				name: u.name,
				stored: u.role ?? null,
				// New code may rely on the field only once the Migration is Done.
				shown: roleReady ? u.role! : (u.role ?? "member"),
			})),
		};
	},
});

/**
 * Insert users. Until the role Migration is Done they get the old shape,
 * without a role, as old code wrote them. Once it is Done, new code writes
 * the role itself, so no user is left for the Migration.
 */
export const addUsers = mutation({
	args: { count: v.number() },
	handler: async (ctx, args) => {
		const count = Math.max(1, Math.min(500, Math.floor(args.count)));
		const stamp = Date.now().toString(36);
		const roleReady = await migrations.isReady(ctx, ROLE);
		for (let i = 0; i < count; i++) {
			const name = `user-${stamp}-${i}`;
			await ctx.db.insert(
				"users",
				roleReady ? { name, role: "member" } : { name },
			);
		}
		return count;
	},
});

/** Insert one request for each of the newest users. Feeds the Rebuild. */
export const addRequests = mutation({
	args: {},
	handler: async (ctx) => {
		const users = await ctx.db.query("users").order("desc").take(20);
		for (const [i, user] of users.entries()) {
			await ctx.db.insert("requests", { userId: user._id, amount: i + 1 });
		}
		return users.length;
	},
});

/** Start a background run of the Plan. */
export const apply = mutation({
	args: {},
	handler: async (ctx) => {
		return await migrations.start(ctx);
	},
});

/** Mark every Rebuild pending and start a background run. */
export const rebuild = mutation({
	args: {},
	handler: async (ctx) => {
		return await migrations.start(ctx, { rebuild: "all" });
	},
});
