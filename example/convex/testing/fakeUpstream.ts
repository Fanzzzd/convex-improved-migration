// Test-only: stands in for an upstream @convex-dev/migrations mount.
import { v } from "convex/values";
import { defineMigrations } from "convex-improved-migration";
import { components } from "../_generated/api";
import { internal } from "../_generated/api";
import { internalQuery } from "../_generated/server";
import schema from "../schema";

export const getStatus = internalQuery({
	args: {
		limit: v.optional(v.number()),
		names: v.optional(v.array(v.string())),
	},
	handler: async () => [
		{ name: "migrations:oldBackfillA", isDone: true },
		{ name: "migrations:oldBackfillB", isDone: true },
		{ name: "migrations:oldInProgress", isDone: false },
	],
});

const m = defineMigrations(components.migration, { schema });
export const adopt = m.adopt({
	lib: { getStatus: internal.testing.fakeUpstream.getStatus },
});
