import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
	users: defineTable({
		name: v.string(),
		// Expand step: optional while the Migration backfills it.
		role: v.optional(v.union(v.literal("member"), v.literal("admin"))),
	}),
	requests: defineTable({ userId: v.id("users"), amount: v.number() }),
	// Derived data, rebuilt by the "request-counters" Rebuild.
	requestCounters: defineTable({
		userId: v.id("users"),
		count: v.number(),
	}).index("by_userId", ["userId"]),
	countries: defineTable({ code: v.string(), name: v.string() }).index(
		"by_code",
		["code"],
	),
	grants: defineTable({ role: v.string(), permission: v.string() }).index(
		"by_role_and_permission",
		["role", "permission"],
	),
});
