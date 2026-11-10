// A Plan whose driver writes progress after every document (batchSize 1),
// so an operator command has to succeed against a driver that never pauses.
import { defineMigrations } from "convex-improved-migration";
import { components } from "./_generated/api";
import schema from "./schema";

const m = defineMigrations(components.migration, { schema, module: "busy" });

export const { apply, status, operate, runStep } = m.plan([
	m.migrate("busy-touch", {
		table: "items",
		range: (q) => q.withIndex("by_n", (r) => r.gte("n", 90000)),
		batchSize: 1,
		run: () => ({ touched: true }),
	}),
]).functions;
