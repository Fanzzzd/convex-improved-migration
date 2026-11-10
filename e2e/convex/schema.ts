import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
	items: defineTable({
		n: v.number(),
		payload: v.optional(v.string()),
		touched: v.optional(v.boolean()),
	}).index("by_n", ["n"]),
	itemCount: defineTable({ count: v.number() }),
	// One row per run of a Seed that wants its runs counted.
	seedRuns: defineTable({ name: v.string() }),
	// The long run: each processed tick adds the next one until enough time
	// has passed since the first.
	ticks: defineTable({ startedAt: v.number(), done: v.optional(v.boolean()) }),
	flags: defineTable({ name: v.string(), on: v.boolean() }).index("by_name", [
		"name",
	]),
});
