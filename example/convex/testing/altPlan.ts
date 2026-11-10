// Test-only: a second Plan on the same component, used to leave an
// unfinished Step behind that the main Plan does not know (an Orphan).
import { defineMigrations } from "convex-improved-migration";
import { components } from "../_generated/api";
import schema from "../schema";

const m = defineMigrations(components.migration, {
	schema,
	module: "testing/altPlan",
});

export const { apply, runStep } = m.plan([
	m.once("removed-before-finishing", async () => {
		throw new Error("this step never finishes");
	}),
]).functions;
