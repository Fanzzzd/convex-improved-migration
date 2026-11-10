// A Plan that writes about 9 MB per Batch, about 144 MB in total, to go over
// the local backend's 4 MiB/s write throttle on purpose.
import { defineMigrations } from "convex-improved-migration";
import { components } from "./_generated/api";
import schema from "./schema";

const m = defineMigrations(components.migration, { schema, module: "burst" });

export const { apply, status, operate, runStep } = m.plan([
	m.migrate("burst-writes", {
		table: "items",
		range: (q) => q.withIndex("by_n", (r) => r.lt("n", 160)),
		batchSize: 10,
		run: (_ctx, i) => ({ payload: (i.n % 2 ? "y" : "z").repeat(900 * 1024) }),
	}),
]).functions;
