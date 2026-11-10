// Test-only: a Plan whose driver does one unit of work per action
// (budgetMs 0), so a test can stop a background run between Batches.
import { defineMigrations } from "convex-improved-migration";
import { components } from "../_generated/api";
import schema from "../schema";

const m = defineMigrations(components.migration, {
	schema,
	module: "testing/stepwise",
	budgetMs: 0,
});

export const stepwise = m.plan([
	m.migrate("stepwise-role", {
		table: "users",
		batchSize: 10,
		needs: (u) => u.role === undefined,
		run: () => ({ role: "member" }),
	}),
]);

export const { apply, status, operate, runStep } = stepwise.functions;
