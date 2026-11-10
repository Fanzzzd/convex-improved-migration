/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import {
	componentsGeneric,
	makeFunctionReference,
	type FunctionReference,
	type GenericSchema,
	type SchemaDefinition,
} from "convex/server";
import schema from "./component/schema.js";
import type { ComponentApi } from "./component/_generated/component.js";
import {
	SHORT_SENTINEL_FLAG,
	type RunStepArgs,
	type VerifyResult,
} from "./shared.js";
const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the component with a convex-test instance.
 * @param name - The mount name from convex.config.ts. Default "migration".
 */
export function register<
	Schema extends SchemaDefinition<GenericSchema, boolean>,
>(t: TestConvex<Schema>, name: string = "migration") {
	// convex-test schedules with setTimeout, which cannot hold the sentinel's
	// four-year delay: it would fire at once and print a warning per apply.
	(globalThis as Record<string, unknown>)[SHORT_SENTINEL_FLAG] = true;
	t.registerComponent(name, schema, modules);
	return componentsGeneric()[name] as unknown as ComponentApi;
}

/**
 * Assert that no document still `needs` the Migration with this id. Runs the
 * same verify pass `apply` runs after the last Batch.
 *
 * ```ts
 * await expectNoneNeed(t, "2026-11-10-user-role");
 * ```
 * @param options.module - The file that exports the Plan. Default "migrations".
 */
export async function expectNoneNeed<
	Schema extends SchemaDefinition<GenericSchema, boolean>,
>(
	t: TestConvex<Schema>,
	id: string,
	options: { module?: string } = {},
): Promise<void> {
	const runStep = makeFunctionReference<"mutation", RunStepArgs, VerifyResult>(
		`${options.module ?? "migrations"}:runStep`,
	) as unknown as FunctionReference<
		"mutation",
		"internal",
		RunStepArgs,
		VerifyResult
	>;
	let cursor: string | null = null;
	let left = 0;
	const samples: string[] = [];
	for (;;) {
		const r: VerifyResult = await t.mutation(runStep, {
			step: id,
			op: "verify",
			cursor,
			batchSize: 500,
		});
		left += r.notMigrated;
		samples.push(...r.samples);
		if (r.isDone) break;
		cursor = r.cursor;
	}
	if (left > 0) {
		throw new Error(
			`${left} document(s) still need "${id}", for example ${samples.slice(0, 10).join(", ")}.`,
		);
	}
}

export default { register, schema, modules };
