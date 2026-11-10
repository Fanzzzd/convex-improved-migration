// Test-only: the main Plan's Rebuild after a Version bump, for Readiness.
import { defineMigrations } from "convex-improved-migration";
import { components } from "../_generated/api";
import schema from "../schema";

const m = defineMigrations(components.migration, {
	schema,
	module: "testing/rebuildV2",
});

export const rebuildV2 = m.plan([
	m.rebuild("request-counters", {
		version: 2,
		table: "requests",
		clear: "requestCounters",
		run: () => {},
	}),
]);

export const { apply, status, operate, runStep } = rebuildV2.functions;
