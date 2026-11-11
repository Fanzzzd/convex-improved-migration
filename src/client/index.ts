import {
	createFunctionHandle,
	internalActionGeneric,
	internalMutationGeneric,
	internalQueryGeneric,
	makeFunctionReference,
	type DataModelFromSchemaDefinition,
	type DocumentByName,
	type FunctionReference,
	type GenericActionCtx,
	type GenericDataModel,
	type GenericDocument,
	type WithoutSystemFields,
	type GenericMutationCtx,
	type GenericSchema,
	type MutationBuilder,
	type NamedTableInfo,
	type OrderedQuery,
	type QueryInitializer,
	type RegisteredAction,
	type RegisteredMutation,
	type RegisteredQuery,
	type SchemaDefinition,
	type TableNamesInDataModel,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import {
	DRY_RUN,
	MAX_RESTARTS,
	MAX_SAMPLES,
	cleanError,
	errorText,
	isWriteConflict,
	retryTransient,
	runLoop,
	runStepArgsValidator,
	startOver,
	stepCommand,
	type BatchResult,
	type ClearResult,
	type DryRunChange,
	type Failure,
	type RunOutcome,
	type Kind,
	type Phase,
	type PlanEntry,
	type RunStepArgs,
	type StepError,
	type VerifyResult,
	type Via,
} from "../shared.js";

export type { DryRunChange, Kind, Phase, StepError, Via } from "../shared.js";

// ---------------------------------------------------------------------------
// Result types. Every function returns one of these fixed shapes.
// ---------------------------------------------------------------------------

export type StepState = "pending" | "running" | "done" | "failed" | "stalled";

export type StepStatus<Id extends string = string> = {
	id: Id;
	kind: Kind;
	/**
	 * False for a Seed or a once Step: one function call, with no table,
	 * Batches, cursor or document counts.
	 */
	table: boolean;
	/** "stalled": recorded as running, but no live driver holds the Lease. */
	state: StepState;
	via: Via | null;
	/** Rebuild only: the Version the recorded data was built for. */
	version: string | null;
	phase: Phase | null;
	processed: number;
	skipped: number;
	batchSize: number | null;
	/** Documents the last verify pass found still needing the Migration. */
	remaining: number | null;
	verified: boolean | null;
	error: StepError | null;
	/** Why the Step is in this state: a markDone reason, or why it is pending. */
	reason: string | null;
	/**
	 * The run that last changed this Step's state. Null after mark-done, reset
	 * or adopt, which no run did.
	 */
	runId: string | null;
	doneAt: string | null;
	/** Dry Run only. */
	wouldRun?: boolean;
	/** Dry Run only: writes the first Batch would make, to every table. */
	changes?: DryRunChange[];
};

export type Orphan = { id: string; state: StepState; via: Via | null };

export type Status<Id extends string = string> = {
	state: "done" | "pending" | "running" | "failed" | "stalled";
	/** The run that holds the Lease, if any. */
	run: {
		id: string;
		mode: "foreground" | "background";
		startedAt: string;
		live: boolean;
	} | null;
	steps: StepStatus<Id>[];
	/** Steps recorded on this deployment but no longer in the Plan. */
	orphans: Orphan[];
	/**
	 * True when this state came from a snapshot import and no apply has run
	 * since. Done Rebuilds then show as pending.
	 */
	importSuspected: boolean;
	/** Commands that make sense now, ready to copy. */
	next: string[];
	/** Event history of one Step, when `status({ events: id })` asks for it. */
	events?: {
		type: string;
		at: string;
		runId: string | null;
		detail: string | null;
	}[];
};

export type ApplyResult<Id extends string = string> = {
	ok: true;
	/** Null for a Dry Run. */
	runId: string | null;
	dryRun: boolean;
	/** `wait: false`: the run was scheduled and `steps` shows the state before it. */
	started: boolean;
	/** True when this run detected state restored from a snapshot. */
	restored: boolean;
	durationMs: number;
	steps: StepStatus<Id>[];
	orphans: Orphan[];
};

export type ApplyArgs<Id extends string = string> = {
	/** Write nothing. Report which Steps would run, plus the first Batch's writes. */
	dryRun?: boolean;
	/** Run one Step out of Plan order. */
	only?: Id;
	/** Mark these Rebuilds pending first, whatever their recorded state. */
	rebuild?: "all" | Id[];
	/** false: schedule the run in the background and return at once. Default true. */
	wait?: boolean;
	/**
	 * Keep waiting for the run with this id, after `apply` threw Still Running.
	 * The run goes on under the same id, so its Seeds do not run again.
	 */
	resume?: string;
};

export type StatusArgs<Id extends string = string> = {
	/** Throw unless every Step is Done. For CI gates. */
	check?: boolean;
	/** Include the Event history of one Step, or "(run)" for run-level Events. */
	events?: Id | "(run)";
};

export type OperateArgs<Id extends string = string> =
	/** Record Done without running. Accepts an Orphan id. */
	| { op: "markDone"; id: Id | (string & {}); reason: string }
	/** Back to pending with an empty cursor. */
	| { op: "reset"; id: Id }
	/**
	 * Stop the run at the next Batch boundary. The Step keeps its cursor.
	 * With `runId`, only that run: a newer run is left alone. Without it,
	 * whatever run holds the deployment when the cancel lands.
	 */
	| { op: "cancel"; runId?: string };

// ---------------------------------------------------------------------------
// Step definitions. Steps are plain objects; only `runStep` is registered.
// ---------------------------------------------------------------------------

type Ctx<DM extends GenericDataModel> = GenericMutationCtx<DM>;
type Patch<Doc extends GenericDocument> =
	| Partial<WithoutSystemFields<Doc>>
	| void
	| null
	| undefined;
type Awaitable<T> = T | Promise<T>;

export type TableOptions<
	DM extends GenericDataModel,
	T extends TableNamesInDataModel<DM>,
> = {
	table: T;
	/** Narrow the scan, for example `(q) => q.withIndex("by_role", ...)`. */
	range?: (
		q: QueryInitializer<NamedTableInfo<DM, T>>,
	) => OrderedQuery<NamedTableInfo<DM, T>>;
	/**
	 * Called once per document. Return fields to patch, or write through `ctx`.
	 * Must be idempotent: `reset` and Rebuilds process documents again.
	 */
	run: (
		ctx: Ctx<DM>,
		doc: DocumentByName<DM, T>,
	) => Awaitable<Patch<DocumentByName<DM, T>>>;
	/** Documents per Batch. Defaults to `defaultBatchSize`. */
	batchSize?: number;
	/** Run `run` for one page concurrently. Batches stay serial. */
	parallelize?: boolean;
};

export type TableMigrateOptions<
	DM extends GenericDataModel,
	T extends TableNamesInDataModel<DM>,
> = TableOptions<DM, T> & {
	/**
	 * True while a document still needs this Migration. Batches skip documents
	 * where it is false, and after the last Batch a verify pass must find no
	 * document where it is true before the Step is Done.
	 */
	needs?: (doc: DocumentByName<DM, T>) => boolean;
};

export type RebuildOptions<
	DM extends GenericDataModel,
	T extends TableNamesInDataModel<DM>,
> = TableOptions<DM, T> & {
	/** Change it when the derived data must be recomputed. */
	version: string | number;
	/**
	 * Runs before the backfill: an app table the component empties in Batches,
	 * or a function that clears the derived data in one mutation.
	 */
	clear?: TableNamesInDataModel<DM> | ((ctx: Ctx<DM>) => Awaitable<void>);
};

/** Table options for any table, discriminated by `table`. */
export type AnyTableMigrateOptions<DM extends GenericDataModel> = {
	[T in TableNamesInDataModel<DM>]: TableMigrateOptions<DM, T>;
}[TableNamesInDataModel<DM>];

export type AnyRebuildOptions<DM extends GenericDataModel> = {
	[T in TableNamesInDataModel<DM>]: RebuildOptions<DM, T>;
}[TableNamesInDataModel<DM>];

/** One Step of the Plan. Create it with `m.migrate`, `m.once`, `m.seed` or `m.rebuild`. */
export type Step<Id extends string = string, Definition = unknown> = {
	readonly id: Id;
	readonly kind: Kind;
	/** The options as written. `definition.run` is reachable from unit tests. */
	readonly definition: Definition;
	/** @internal */
	readonly _def: StepDef;
};

type StepDef = {
	oneShot: boolean;
	version?: string;
	verify: boolean;
	clear: boolean;
	/** The clear is a function: one call, not pages of a table. */
	clearOnce?: boolean;
	batchSize?: number;
	ops: Partial<
		Record<RunStepArgs["op"], (ctx: any, args: RunStepArgs) => Promise<unknown>>
	>;
};

// ---------------------------------------------------------------------------
// The Plan object.
// ---------------------------------------------------------------------------

// The action signatures are the narrowest; query, mutation and action
// contexts all satisfy them.
type QueryRunner = { runQuery: GenericActionCtx<GenericDataModel>["runQuery"] };
type MutationRunner = {
	runMutation: GenericActionCtx<GenericDataModel>["runMutation"];
};

export interface Migrations<S extends Step, Id extends string = S["id"]> {
	/** The four registered functions. Destructure and export them from `module`. */
	readonly functions: {
		/** Run every Step that needs to run, wait, and throw on failure. */
		apply: RegisteredAction<
			"internal",
			ApplyArgs<Id>,
			Promise<ApplyResult<Id>>
		>;
		status: RegisteredQuery<"internal", StatusArgs<Id>, Promise<Status<Id>>>;
		/**
		 * markDone, reset and cancel. An action, so each write is a short
		 * transaction of its own that a busy driver cannot keep failing.
		 */
		operate: RegisteredAction<"internal", OperateArgs<Id>, Promise<Status<Id>>>;
		/** The one mutation the component calls for every Batch. */
		runStep: RegisteredMutation<"internal", RunStepArgs, Promise<unknown>>;
	};
	/**
	 * Readiness: true when the Step is Done on this deployment and, for a
	 * Rebuild, built for the current Version. Call it from queries and
	 * mutations to choose the new or the legacy path.
	 */
	isReady(ctx: QueryRunner, id: Id): Promise<boolean>;
	/** Same data as the `status` function, for app code. */
	status(ctx: QueryRunner): Promise<Status<Id>>;
	/** Schedule a background run from a mutation or action. Returns at once. */
	start(
		ctx: MutationRunner,
		options?: { only?: Id; rebuild?: "all" | Id[] },
	): Promise<{ runId: string }>;
	/** The Step as declared, for unit tests: `migrations.step(id).definition.run`. */
	step<I extends Id>(id: I): Extract<S, { id: I }>;
	readonly ids: readonly Id[];
}

/** The part of an upstream `@convex-dev/migrations` mount Adoption reads. */
export type UpstreamMigrationsComponent = {
	lib: {
		getStatus: FunctionReference<
			"query",
			"internal",
			{ limit?: number; names?: string[] },
			Array<{ name: string; isDone: boolean }>
		>;
	};
};

export type Options<DataModel extends GenericDataModel> = {
	/** Builder for `runStep`. Pass a trigger-wrapped one to fire triggers. */
	internalMutation?: MutationBuilder<DataModel, "internal">;
	/** File that exports the four functions. Default "migrations" (convex/migrations.ts). */
	module?: string;
	/** Documents per Batch when a Step does not set `batchSize`. Default 100. */
	defaultBatchSize?: number;
	/**
	 * How long one background driver action works before it schedules the next
	 * one. Default 20 minutes.
	 */
	budgetMs?: number;
	/**
	 * How long a foreground `apply` works before it moves the run to the
	 * background and throws Still Running. `npx convex run` drops a call after
	 * 300 s, so keep this below. Default 4 minutes, or `budgetMs` when that is
	 * shorter.
	 */
	foregroundBudgetMs?: number;
};

/** Pseudo Step id for run-level Events. Not a valid Step id. */
const RUN_EVENTS = "(run)";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;

/** The command line program. Its name equals the package name on purpose. */
const BIN = "npx convex-improved-migration";

/**
 * Define the migration Plan of one app.
 *
 * ```ts
 * const m = defineMigrations(components.migration, { schema });
 * export const migrations = m.plan([
 *   m.seed("countries", async (ctx) => { ... }),
 *   m.migrate("2026-11-10-user-role", {
 *     table: "users",
 *     needs: (u) => u.role === undefined,
 *     run: () => ({ role: "member" }),
 *   }),
 * ]);
 * export const { apply, status, operate, runStep } = migrations.functions;
 * ```
 */
export function defineMigrations<
	Schema extends SchemaDefinition<GenericSchema, boolean>,
>(
	component: ComponentApi,
	options: Options<DataModelFromSchemaDefinition<Schema>> & { schema: Schema },
) {
	type DM = DataModelFromSchemaDefinition<Schema>;
	const builder = (options.internalMutation ??
		internalMutationGeneric) as MutationBuilder<DM, "internal">;
	const defaultBatchSize = options.defaultBatchSize ?? 100;
	const budgetMs = options.budgetMs ?? 20 * 60 * 1000;
	const foregroundBudgetMs =
		options.foregroundBudgetMs ?? Math.min(budgetMs, 4 * 60 * 1000);
	const module = options.module ?? "migrations";
	const tables = Object.keys(options.schema.tables);

	function tableOps<T extends TableNamesInDataModel<DM>>(
		o: TableOptions<DM, T>,
		needs?: (doc: DocumentByName<DM, T>) => boolean,
	) {
		const query = (ctx: Ctx<DM>) => {
			const q = ctx.db.query(o.table);
			return o.range ? o.range(q) : q;
		};
		const batch = async (
			runCtx: Ctx<DM>,
			args: RunStepArgs,
		): Promise<BatchResult> => {
			const page = await query(runCtx).paginate({
				cursor: args.cursor ?? null,
				numItems: args.batchSize ?? o.batchSize ?? defaultBatchSize,
			});
			let processed = 0;
			let skipped = 0;
			const one = async (doc: DocumentByName<DM, T>) => {
				if (needs && !needs(doc)) {
					skipped++;
					return;
				}
				const patch = await o.run(runCtx, doc);
				if (patch && Object.keys(patch).length > 0) {
					await runCtx.db.patch(o.table, doc._id, patch as any);
				}
				processed++;
			};
			if (o.parallelize) await Promise.all(page.page.map(one));
			else for (const doc of page.page) await one(doc);
			console.log(
				`[migration] ${args.step}: batch of ${page.page.length} (${processed} processed, ${skipped} skipped)`,
			);
			return {
				cursor: page.continueCursor,
				isDone: page.isDone,
				processed,
				skipped,
			};
		};
		const verify = async (
			ctx: Ctx<DM>,
			args: RunStepArgs,
		): Promise<VerifyResult> => {
			const page = await query(ctx).paginate({
				cursor: args.cursor ?? null,
				numItems: args.batchSize ?? o.batchSize ?? defaultBatchSize,
			});
			const left = page.page.filter((doc) => needs!(doc));
			return {
				cursor: page.continueCursor,
				isDone: page.isDone,
				notMigrated: left.length,
				samples: left.slice(0, MAX_SAMPLES).map((d) => d._id as string),
			};
		};
		return { batch, verify };
	}

	/** A Migration over a table: runs once per deployment, Batch by Batch. */
	function migrate<const Id extends string>(
		id: Id,
		o: AnyTableMigrateOptions<DM>,
	): Step<Id, AnyTableMigrateOptions<DM>> {
		const table = o as TableMigrateOptions<DM, TableNamesInDataModel<DM>>;
		const { batch, verify } = tableOps(table, table.needs);
		return makeStep(id, "migration", o, {
			oneShot: false,
			verify: o.needs !== undefined,
			clear: false,
			batchSize: o.batchSize,
			ops: o.needs ? { batch, verify } : { batch },
		});
	}

	/** A Migration without a table: one mutation, once per deployment. */
	function once<const Id extends string>(
		id: Id,
		run: (ctx: Ctx<DM>) => Awaitable<void>,
	): Step<Id, { run: (ctx: Ctx<DM>) => Awaitable<void> }> {
		return makeStep(
			id,
			"migration",
			{ run },
			{
				oneShot: true,
				verify: false,
				clear: false,
				ops: { run: async (ctx) => void (await run(ctx)) },
			},
		);
	}

	/** A Seed: runs on every apply, as one mutation. Must be idempotent. */
	function seed<const Id extends string>(
		id: Id,
		run: (ctx: Ctx<DM>) => Awaitable<void>,
	): Step<Id, { run: (ctx: Ctx<DM>) => Awaitable<void> }> {
		return makeStep(
			id,
			"seed",
			{ run },
			{
				oneShot: true,
				verify: false,
				clear: false,
				ops: { run: async (ctx) => void (await run(ctx)) },
			},
		);
	}

	/** A Rebuild: recomputes derived data when its version changes. */
	function rebuild<const Id extends string>(
		id: Id,
		options: AnyRebuildOptions<DM>,
	): Step<Id, AnyRebuildOptions<DM>> {
		const o = options as RebuildOptions<DM, TableNamesInDataModel<DM>>;
		const { batch } = tableOps(o);
		const clear = o.clear;
		// The clear would delete the data the Rebuild reads, and the Step would
		// still end Done.
		if (clear === o.table) {
			throw new Error(
				`Rebuild "${id}" clears "${clear}", the table it reads. clear must name the derived table it rebuilds.`,
			);
		}
		return makeStep(id, "rebuild", options, {
			oneShot: false,
			version: String(o.version),
			verify: false,
			clear: clear !== undefined,
			clearOnce: typeof clear === "function",
			batchSize: o.batchSize,
			ops: {
				batch,
				clear: async (ctx: Ctx<DM>, args): Promise<ClearResult> => {
					if (typeof clear === "function") {
						await clear(ctx);
						return { cursor: null, isDone: true };
					}
					const size = args.batchSize ?? defaultBatchSize;
					const docs = await ctx.db.query(clear!).take(size);
					for (const doc of docs) await ctx.db.delete(clear!, doc._id);
					return { cursor: null, isDone: docs.length < size };
				},
			},
		});
	}

	/**
	 * Adoption: copy Done names from an existing `@convex-dev/migrations`
	 * mount. Steps carried over keep the upstream function name as their id.
	 * Refuses unless the number of Done rows equals `expectCount`.
	 */
	function adopt(upstream: UpstreamMigrationsComponent) {
		return internalMutationGeneric({
			args: { expectCount: v.number() },
			handler: async (ctx, args) => {
				const rows = await ctx.runQuery(upstream.lib.getStatus, {
					limit: 100_000,
				});
				const done = rows.filter((r) => r.isDone).map((r) => r.name);
				if (done.length !== args.expectCount) {
					throw new Error(
						`Adoption expected ${args.expectCount} done migrations upstream but found ${done.length}. Nothing was recorded.`,
					);
				}
				const r = await ctx.runMutation(component.lib.adopt, { names: done });
				if (r.running.length) {
					throw new Error(
						`Refusing to adopt: a run is working on ${r.running.map((n) => `"${n}"`).join(", ")} right now. ` +
							`Stop the run first with ${BIN} cancel${module === "migrations" ? "" : ` --module ${module}`}, then try again. Nothing was recorded.`,
					);
				}
				return { adopted: r.adopted, alreadyDone: r.alreadyDone };
			},
		}) as RegisteredMutation<
			"internal",
			{ expectCount: number },
			Promise<{ adopted: number; alreadyDone: number }>
		>;
	}

	function plan<const S extends readonly Step[]>(
		steps: S,
	): Migrations<S[number]> {
		type Id = S[number]["id"];
		const byId = new Map<string, Step>();
		for (const s of steps) {
			if (!ID_PATTERN.test(s.id)) {
				throw new Error(
					`Step id "${s.id}" must start with a letter or digit and use only letters, digits and _ . : / -.`,
				);
			}
			if (byId.has(s.id)) {
				throw new Error(`Two Steps in the Plan share the id "${s.id}".`);
			}
			byId.set(s.id, s);
		}
		const cli = (command: string) =>
			`${BIN} ${command}${module === "migrations" ? "" : ` --module ${module}`}`;

		const runStep = builder({
			args: runStepArgsValidator,
			handler: async (ctx: Ctx<DM>, args: RunStepArgs) => {
				const s = byId.get(args.step);
				if (!s) {
					throw new Error(`No Step "${args.step}" in this deployment's Plan.`);
				}
				const op = s._def.ops[args.op];
				if (!op && args.op === "verify") {
					// Only expectNoneNeed asks a Step without `needs` to verify.
					throw new Error(
						`Step "${args.step}" has no needs predicate, so there is nothing to verify. Give the Step needs, or do not call expectNoneNeed for it.`,
					);
				}
				if (!op)
					throw new Error(`A ${s.kind} Step has no "${args.op}" operation.`);
				try {
					if (!args.dryRun) return await op(ctx, args);
					// Dry Run: record every write, then roll all of them back by
					// throwing an error that carries the record.
					const changes: DryRunChange[] = [];
					const runCtx: Ctx<DM> = {
						...ctx,
						db: recordingDb(ctx.db, tables, changes),
					};
					const clear = args.clearFirst ? s._def.ops.clear : undefined;
					const cleared = clear
						? ((await clear(runCtx, {
								...args,
								op: "clear",
								cursor: null,
							})) as ClearResult)
						: null;
					const result = (await op(runCtx, args)) as BatchResult;
					throw new ConvexError({
						kind: DRY_RUN,
						processed: result.processed,
						skipped: result.skipped,
						clearDone: cleared ? cleared.isDone : null,
						changes: toJson(changes.slice(0, MAX_SAMPLES * 2)),
					});
				} catch (e) {
					if (e instanceof ConvexError || !PAGINATE_ERROR.test(errorText(e)))
						throw e;
					// convex-test allows one paginated query per function. A deployed
					// backend accepts more in a mutation (e2e/e2e.sh checks it). Say
					// which of the Step's functions used the one up.
					const hint =
						args.op !== "batch"
							? `"${args.step}" calls .paginate() more than once in one function.`
							: args.clearFirst
								? `"${args.step}" calls .paginate() in run or clear. A Dry Run runs clear and the first Batch in one function.`
								: `"${args.step}" calls .paginate() in run. Each Batch already runs one paginated query.`;
					throw new Error(
						`${errorText(e)} Hint: ${hint} This runtime allows one per function. Use .take() or .collect().`,
					);
				}
			},
		}) as Migrations<Step>["functions"]["runStep"];

		const runStepRef = makeFunctionReference<"mutation", RunStepArgs>(
			`${module}:runStep`,
		);

		function planEntries(handle: string): PlanEntry[] {
			return steps.map((s) => ({
				name: s.id,
				handle,
				kind: s.kind,
				oneShot: s._def.oneShot,
				version: s._def.version,
				verify: s._def.verify,
				clear: s._def.clear,
				clearOnce: s._def.clearOnce,
				batchSize: s._def.batchSize ?? defaultBatchSize,
			}));
		}

		async function entries(): Promise<PlanEntry[]> {
			let handle: string;
			try {
				handle = await createFunctionHandle(runStepRef);
			} catch (e) {
				throw new Error(
					`Could not find ${module}:runStep. Export runStep from the file that calls m.plan(), ` +
						`and set defineMigrations(..., { module }) if that file is not convex/${module}.ts. (${errorText(e)})`,
				);
			}
			return planEntries(handle);
		}

		function find(entriesList: PlanEntry[], id: string): PlanEntry {
			const entry = entriesList.find((e) => e.name === id);
			if (!entry) {
				throw new Error(
					`No Step "${id}" in the Plan. Known: ${entriesList.map((e) => e.name).join(", ")}.`,
				);
			}
			return entry;
		}

		/** Validate `only` and `rebuild` before anything is written. */
		function targets(list: PlanEntry[], args: ApplyArgs<string>) {
			if (args.only !== undefined) find(list, args.only);
			if (args.rebuild === undefined) return undefined;
			const picked =
				args.rebuild === "all"
					? list.filter((e) => e.kind === "rebuild")
					: args.rebuild.map((id) => find(list, id));
			const wrong = picked.find((e) => e.kind !== "rebuild");
			if (wrong) {
				throw new Error(
					`"${wrong.name}" is a ${wrong.kind}, not a rebuild. Use ${cli(stepCommand("reset", wrong.name))} instead.`,
				);
			}
			return picked.map((e) => e.name);
		}

		/** The `npx convex run` call that goes on waiting for a run. */
		function resumeCommand(runId: string, only: string | null | undefined) {
			return `npx convex run ${module}:apply '${JSON.stringify({
				resume: runId,
				...(only ? { only } : {}),
			})}'`;
		}

		function canceledError(): Error {
			return new Error(
				`Canceled. The interrupted Step keeps its cursor; ${cli("apply")} resumes it.`,
			);
		}

		function orphanError(orphans: { name: string; state: string }[]): Error {
			const list = orphans.map((o) => `"${o.name}" (${o.state})`).join(", ");
			return new Error(
				`Refusing to run: ${list} ${orphans.length === 1 ? "was" : "were"} removed from the Plan before finishing on this deployment. ` +
					`Put the Step back and run apply, or record it with ${cli(stepCommand("mark-done", orphans[0]?.name ?? "<step>", ' --reason "..."'))}.`,
			);
		}

		function runningError(id: string, op: string): Error {
			return new Error(
				`Refusing to ${op} "${id}": a run is working on it right now. ` +
					`Stop the run first with ${cli("cancel")}, then try again.`,
			);
		}

		function failureError(failure: Failure): Error {
			const { error, name } = failure;
			// A Seed or a once Step is one call: no Batch, cursor or count.
			const table = !byId.get(name)?._def.oneShot;
			const where = !table
				? ""
				: error.phase === "verify"
					? " during verification"
					: ` on batch ${error.batch} after ${error.processed} document(s) (batch size ${error.batchSize})`;
			return new Error(
				[
					`Step "${name}" (${failure.kind}) failed${where}.`,
					`Error: ${error.message}`,
					failure.later.length
						? `Later Steps did not run: ${failure.later.join(", ")}.`
						: "No later Steps.",
					table
						? `Next: fix the cause, then ${cli("apply")} resumes from the saved cursor.`
						: `Next: fix the cause, then ${cli("apply")} runs it again.`,
					...(table
						? [`Or restart this Step: ${cli(stepCommand("reset", name))}`]
						: []),
					`Or record it as done without running: ${cli(stepCommand("mark-done", name, ' --reason "..."'))}`,
				].join("\n"),
			);
		}

		/**
		 * `apply({ resume })` found that the run is over. Report how it ended,
		 * from the run's own record. The Steps may have changed since.
		 */
		async function ended(
			ctx: QueryRunner,
			list: PlanEntry[],
			runId: string,
			end: { outcome: RunOutcome | null; failure?: Failure; by?: string },
			t0: number,
		): Promise<ApplyResult<Id>> {
			switch (end.outcome) {
				case "canceled":
					throw canceledError();
				case "failed":
					throw failureError(end.failure!);
				case "taken over":
					throw new Error(
						`Another apply (run ${end.by}) took over run ${runId}. Check with ${cli("status")}.`,
					);
				case "stalled":
					throw new Error(
						`Run ${runId} stopped: its background driver ended ${MAX_RESTARTS} times in a row without progress. ${cli("apply")} continues the work.`,
					);
				case null: {
					const status = await summarize(ctx, list);
					throw new Error(
						`Run ${runId} ended before the Plan finished; the Plan is ${status.state}. ${cli("apply")} continues it.`,
					);
				}
			}
			const status = await summarize(ctx, list);
			return {
				ok: true,
				runId,
				dryRun: false,
				started: false,
				// The Lease that carried the flag is gone. The Still Running error
				// of the first call said so.
				restored: false,
				durationMs: Date.now() - t0,
				steps: status.steps,
				orphans: status.orphans,
			};
		}

		async function summarize(
			ctx: QueryRunner,
			list: PlanEntry[],
			eventsFor?: string,
		): Promise<Status<Id>> {
			const s = await ctx.runQuery(component.lib.status, { eventsFor });
			const rows = new Map(s.rows.map((r) => [r.name, r]));
			const now = Date.now();
			const lease = s.lease;
			const leaseLive =
				lease !== null && lease.expiresAt > now && lease.holder !== "canceled";
			const stepStatuses: StepStatus<Id>[] = list.map((e) => {
				const row = rows.get(e.name);
				let state: StepState = row?.state ?? "pending";
				let reason: string | null = null;
				if (!row) reason = "never ran";
				else {
					const live = leaseLive && lease!.runId === row.runId;
					const hasProgress = row.phase !== null || row.batches > 0;
					// The rule apply uses. `due`: a Rebuild that apply starts over
					// for a cause, with its clear.
					const start = startOver(e, row, hasProgress, {
						importSuspected: s.restoreSuspected,
					});
					const due = start.why !== null && start.why !== "rebuild";
					if (row.state === "done") {
						if (due) {
							state = "pending";
							reason = `${start.why}; apply rebuilds it`;
						} else {
							reason =
								`done via ${row.via} on ${iso(row.doneAt)}` +
								(row.reason && row.via !== "ran" ? `: ${row.reason}` : "");
						}
					} else if (row.state === "running" && !live) {
						state = "stalled";
						reason = `no live driver; ${due ? `${start.why}; apply starts it over` : "apply resumes it"}`;
					} else if (row.state === "failed") {
						// The failure stays visible either way.
						if (due) reason = `${start.why}; apply starts it over`;
					} else if (row.state === "pending") {
						// Only cancel leaves a pending Step with saved progress. reset,
						// mark-done and adopt delete it. A cancel during the clear left
						// no Batch yet.
						const canceled = hasProgress ? "canceled; " : "";
						if (due) reason = `${canceled}${start.why}; apply starts it over`;
						else if (hasProgress) reason = "canceled; apply resumes it";
						else reason = "reset; apply runs it from the start";
					}
				}
				return {
					id: e.name as Id,
					kind: e.kind,
					table: !e.oneShot,
					state,
					via: row?.via ?? null,
					version: row?.version ?? null,
					phase: row?.phase ?? null,
					processed: row?.processed ?? 0,
					skipped: row?.skipped ?? 0,
					batchSize: row?.batchSize ?? null,
					remaining: row?.notMigrated ?? null,
					verified: row?.verified ?? null,
					error: row?.error ?? null,
					reason,
					runId: row?.runId ?? null,
					doneAt: row?.doneAt ? iso(row.doneAt) : null,
				};
			});
			// Orphans are Steps outside the whole Plan, also when `list` is one
			// Step picked with `only`.
			const ids = new Set<string>(steps.map((step) => step.id));
			const orphans: Orphan[] = s.rows
				.filter((r) => !ids.has(r.name))
				.map((r) => ({ id: r.name, state: r.state, via: r.via }));
			const unfinished = orphans.filter((o) => o.state !== "done");
			const failed = stepStatuses.find((st) => st.state === "failed");
			const state: Status["state"] = failed
				? "failed"
				: leaseLive
					? "running"
					: stepStatuses.some((st) => st.state === "stalled")
						? "stalled"
						: stepStatuses.every((st) => st.state === "done") &&
							  unfinished.length === 0
							? "done"
							: "pending";
			const next: string[] = [];
			if (failed) {
				next.push(
					cli(`status --events ${failed.id}`),
					cli("apply"),
					cli(stepCommand("reset", failed.id)),
					cli(stepCommand("mark-done", failed.id, ' --reason "..."')),
				);
			} else if (state === "running") {
				next.push(cli("status"), cli("cancel"));
			} else if (state !== "done") {
				for (const o of unfinished)
					next.push(cli(stepCommand("mark-done", o.id, ' --reason "..."')));
				if (unfinished.length === 0) next.push(cli("apply"));
			}
			return {
				state,
				run: lease
					? {
							id: lease.runId,
							mode: lease.mode,
							startedAt: iso(lease.startedAt),
							live: leaseLive,
						}
					: null,
				steps: stepStatuses,
				orphans,
				importSuspected: s.restoreSuspected,
				next,
				...(eventsFor
					? {
							events: s.events.map((ev) => ({
								type: ev.type,
								at: iso(ev.at),
								runId: ev.runId,
								detail: ev.detail,
							})),
						}
					: {}),
			};
		}

		async function preview(
			ctx: GenericActionCtx<GenericDataModel>,
			t0: number,
			only?: string,
		): Promise<ApplyResult<Id>> {
			const all = await entries();
			const list = only ? [find(all, only)] : all;
			const prep = await ctx.runMutation(component.lib.prepare, {
				plan: all,
				runId: randomId(),
				mode: "read",
			});
			// apply refuses before its first Batch here, so the dry run does too.
			if (prep.unfinishedOrphans.length)
				throw orphanError(prep.unfinishedOrphans);
			const base = await summarize(ctx, list);
			const raw = await ctx.runQuery(component.lib.status, {});
			const rows = new Map(raw.rows.map((r) => [r.name, r]));
			const out: StepStatus<Id>[] = [];
			for (const [i, e] of list.entries()) {
				const st = base.steps[i];
				if (!st) continue;
				const wouldRun = e.kind === "seed" || st.state !== "done";
				const summary: StepStatus<Id> = { ...st, wouldRun };
				if (st.state === "failed")
					summary.reason = `failed; ${st.reason ?? (e.oneShot ? "apply runs it again" : "apply resumes from the saved cursor")}`;
				if (wouldRun && !e.oneShot) {
					// Preview the Batch apply would run next. A Step that starts over
					// (never ran, reset, or a Rebuild that is due) begins at the first
					// page, after its clear. A Step with saved progress continues at
					// its cursor.
					const row = rows.get(e.name);
					// The rule apply uses.
					const startsOver = startOver(
						e,
						row ?? null,
						row ? row.phase !== null || row.batches > 0 : false,
						{ importSuspected: raw.restoreSuspected },
					).over;
					const phase = startsOver
						? e.clear
							? "clear"
							: "migrate"
						: row!.phase;
					// A Dry Run is one function call. Stop previewing Batches in time
					// to answer, and say so for the Steps that are left.
					if (Date.now() - t0 > foregroundBudgetMs) {
						summary.reason = `${summary.reason ?? "would run"}; no batch preview, because the dry run reached its time budget. Preview it with only`;
						out.push(summary);
						continue;
					}
					if (phase === "verify") {
						summary.reason = `${summary.reason ?? "would run"}; only the verify pass is left, which writes nothing`;
						summary.changes = [];
						out.push(summary);
						continue;
					}
					const tryBatch = async (clearFirst: boolean): Promise<unknown> => {
						try {
							await ctx.runMutation(runStepRef, {
								step: e.name,
								op: "batch",
								cursor: startsOver || phase === "clear" ? null : row!.cursor,
								batchSize: (!startsOver && row!.batchSize) || e.batchSize,
								dryRun: true,
								clearFirst,
							});
							return new Error("the Dry Run batch did not roll back");
						} catch (err) {
							return err;
						}
					};
					let err = await tryBatch(phase === "clear");
					// A clear function may paginate. Where the runtime allows one
					// paginated query per function (convex-test), clear plus the Batch
					// is one too many, so preview the Batch alone.
					let clearSkipped = false;
					if (
						phase === "clear" &&
						!(err instanceof ConvexError) &&
						PAGINATE_ERROR.test(errorText(err))
					) {
						const alone = await tryBatch(false);
						if (alone instanceof ConvexError) {
							err = alone;
							clearSkipped = true;
						}
					}
					{
						const data = err instanceof ConvexError ? (err.data as any) : null;
						if (data?.kind === DRY_RUN) {
							summary.changes = data.changes as DryRunChange[];
							const notes = [
								!startsOver && phase === "migrate" && row!.cursor !== null
									? `preview of batch ${row!.batches + 1}, from the saved cursor`
									: null,
								data.clearDone === true ? "preview includes the clear" : null,
								clearSkipped
									? "preview does not include the clear, because clear calls .paginate() and this runtime allows one paginated query per function"
									: null,
								data.clearDone === false
									? "preview includes only the first page of the clear, so the batch ran on partly cleared data"
									: null,
							].filter((n) => n !== null);
							if (notes.length)
								summary.reason = [summary.reason, ...notes]
									.filter(Boolean)
									.join("; ");
						} else {
							summary.reason = `${summary.reason ?? "would run"}; dry-run batch threw: ${cleanError(errorText(err))}`;
						}
					}
				}
				out.push(summary);
			}
			return {
				ok: true,
				runId: null,
				dryRun: true,
				started: false,
				restored: false,
				durationMs: Date.now() - t0,
				steps: out,
				orphans: base.orphans,
			};
		}

		const apply = internalActionGeneric({
			args: {
				dryRun: v.optional(v.boolean()),
				only: v.optional(v.string()),
				rebuild: v.optional(v.union(v.literal("all"), v.array(v.string()))),
				wait: v.optional(v.boolean()),
				resume: v.optional(v.string()),
			},
			handler: async (ctx, args): Promise<ApplyResult<Id>> => {
				const t0 = Date.now();
				if (args.dryRun) {
					if (
						args.rebuild !== undefined ||
						args.wait !== undefined ||
						args.resume !== undefined
					) {
						throw new Error(
							"dryRun only takes `only`. Do not combine it with rebuild, wait or resume.",
						);
					}
					return await preview(ctx, t0, args.only);
				}
				const all = await entries();
				const list = args.only ? [find(all, args.only)] : all;
				const background = args.wait === false;
				let runId: string;
				let holder: string;
				let restored: boolean;
				// Throttle retries in a row that earlier Drivers of the run made.
				let retriesSoFar = 0;
				if (args.resume !== undefined) {
					if (background || args.rebuild !== undefined) {
						throw new Error(
							"resume keeps waiting for a run that exists. Do not combine it with rebuild or wait: false.",
						);
					}
					runId = args.resume;
					const back = await retryTransient(() =>
						ctx.runMutation(component.lib.resume, { runId, only: args.only }),
					);
					if (back.unknown) {
						throw new Error(
							`No run "${runId}" on this deployment. Start one with ${cli("apply")}.`,
						);
					}
					if (back.scope) {
						throw new Error(
							(back.scope.only === null
								? `Run ${runId} covers the whole Plan.`
								: `Run ${runId} was started with only "${back.scope.only}".`) +
								` Resume it with: ${resumeCommand(runId, back.scope.only)}`,
						);
					}
					if (back.holder === null) {
						return await ended(ctx, list, runId, back.ended!, t0);
					}
					holder = back.holder;
					restored = back.restored;
					retriesSoFar = back.retries;
				} else {
					const rebuildIds = targets(all, args);
					runId = randomId();
					const prep = await retryTransient(() =>
						ctx.runMutation(component.lib.prepare, {
							plan: all,
							runId,
							mode: background ? "background" : "foreground",
							only: args.only,
							rebuild: rebuildIds,
							budgetMs,
						}),
					);
					if (prep.unfinishedOrphans.length)
						throw orphanError(prep.unfinishedOrphans);
					holder = prep.holder!;
					restored = prep.restored;
				}
				const result = (status: Status<Id>) => ({
					ok: true as const,
					runId,
					dryRun: false,
					started: background,
					restored,
					durationMs: Date.now() - t0,
					steps: status.steps,
					orphans: status.orphans,
				});
				if (background) return result(await summarize(ctx, list));
				let handedOff = false;
				let handOff: "handed" | "canceled" | "lost";
				try {
					const outcome = await runLoop(
						{
							advance: (throttled) =>
								ctx.runMutation(component.lib.advance, {
									plan: list,
									runId,
									holder,
									throttled,
								}),
							recordAbort: (message, throttled) =>
								ctx.runMutation(component.lib.recordAbort, {
									plan: list,
									runId,
									holder,
									message,
									throttled,
								}),
						},
						t0 + foregroundBudgetMs,
						retriesSoFar,
					);
					switch (outcome.status) {
						case "done":
							return result(await summarize(ctx, list));
						case "failed":
							throw failureError(outcome.failure);
						case "preempted":
							throw new Error(
								`Another apply took over this run and continues the work. Check with ${cli("status")}.`,
							);
						case "canceled":
							throw canceledError();
						case "budget":
							handOff = await retryTransient(() =>
								ctx.runMutation(component.lib.handOff, {
									plan: list,
									runId,
									holder,
									budgetMs,
									throttled: outcome.throttled,
									retries: outcome.retries,
								}),
							);
							handedOff = handOff === "handed";
							if (handOff === "canceled") throw canceledError();
							if (!handedOff) {
								throw new Error(
									`Another apply took over this run and continues the work. Check with ${cli("status")}.`,
								);
							}
							throw new Error(
								`Still running: run ${runId} continues in the background after ${Math.round(
									(Date.now() - t0) / 1000,
								)}s.` +
									(restored
										? " Snapshot import detected: Rebuilds run again."
										: "") +
									` Keep waiting with: ${resumeCommand(runId, args.only)}. ${cli("apply")} does that by itself. Look with ${cli("status")}.`,
							);
					}
				} finally {
					if (!handedOff) {
						// The run already has its outcome, and a Lease nobody renews
						// expires by itself. A failed release must not replace the
						// outcome.
						await retryTransient(() =>
							ctx.runMutation(component.lib.release, { holder, runId }),
						).catch(() => {});
					}
				}
			},
		}) as Migrations<S[number]>["functions"]["apply"];

		const status = internalQueryGeneric({
			args: { check: v.optional(v.boolean()), events: v.optional(v.string()) },
			handler: async (ctx, args): Promise<Status<Id>> => {
				const list = planEntries("");
				// "(run)" holds run-level Events: handover, watchdog restarts, stalls.
				const eventsFor =
					args.events === RUN_EVENTS
						? RUN_EVENTS
						: args.events
							? find(list, args.events).name
							: undefined;
				const result = await summarize(ctx, list, eventsFor);
				if (args.check && result.state !== "done") {
					const bad = result.steps
						.filter((s) => s.state !== "done")
						.map(
							(s) => `${s.id} (${s.state}${s.reason ? `: ${s.reason}` : ""})`,
						);
					const orphans = result.orphans
						.filter((o) => o.state !== "done")
						.map((o) => `${o.id} (removed from the Plan, ${o.state})`);
					throw new Error(
						`Not every Step is done: ${[...bad, ...orphans].join(", ")}. Next: ${result.next.join(" ; ")}`,
					);
				}
				return result;
			},
		}) as Migrations<S[number]>["functions"]["status"];

		const operate = internalActionGeneric({
			args: {
				op: v.union(
					v.literal("markDone"),
					v.literal("reset"),
					v.literal("cancel"),
				),
				id: v.optional(v.string()),
				reason: v.optional(v.string()),
				runId: v.optional(v.string()),
			},
			handler: async (ctx, args): Promise<Status<Id>> => {
				const list = planEntries("");
				const needId = () => {
					if (!args.id) throw new Error(`operate ${args.op} needs an id.`);
					return args.id;
				};
				// An argument the operation does not read must not pass silently.
				if (args.op !== "markDone" && args.reason !== undefined) {
					throw new Error(`operate ${args.op} takes no reason.`);
				}
				if (args.op === "cancel" && args.id !== undefined) {
					throw new Error(
						"operate cancel takes no id. It stops the run, not one Step. To name the run, pass runId.",
					);
				}
				if (args.op !== "cancel" && args.runId !== undefined) {
					throw new Error(`operate ${args.op} takes no runId.`);
				}
				// Each write below is its own small transaction. It reads only the
				// Lease and the rows of one Step, not the progress the driver writes
				// after every Batch, and it is tried again after a write conflict.
				// Status is read afterwards, in a query of its own.
				if (args.op === "markDone") {
					const id = needId();
					if (!args.reason?.trim()) {
						throw new Error(
							"mark-done needs a reason; it is kept in the Event log.",
						);
					}
					let entry = list.find((e) => e.name === id) as
						| Pick<PlanEntry, "name" | "kind" | "version">
						| undefined;
					if (!entry) {
						const s = await ctx.runQuery(component.lib.status, {});
						const row = s.rows.find((r) => r.name === id);
						if (!row) find(list, id);
						entry = {
							name: id,
							kind: row!.kind,
							version: row!.version ?? undefined,
						};
					}
					const outcome = await retryTransient(() =>
						ctx.runMutation(component.lib.markDone, {
							name: entry.name,
							kind: entry.kind,
							version: entry.version,
							reason: args.reason!,
						}),
					);
					if (outcome === "running") throw runningError(id, "mark-done");
					if (outcome === "import") {
						throw new Error(
							`Refusing to mark-done "${id}": a snapshot import is suspected; apply rebuilds every Rebuild. Nothing changed. Run ${cli("apply")}.`,
						);
					}
					if (outcome === "done") {
						const now = await summarize(ctx, list);
						const shown = now.steps.find((x) => x.id === id);
						const how =
							shown?.reason ??
							`done via ${now.orphans.find((o) => o.id === id)?.via}`;
						// reset works only on a Step in the Plan.
						throw new Error(
							`"${id}" is already done (${how}). Nothing changed.` +
								(shown
									? ` To record it again, run ${cli(stepCommand("reset", id))} first.`
									: ""),
						);
					}
				} else if (args.op === "reset") {
					const id = find(list, needId()).name;
					const outcome = await retryTransient(() =>
						ctx.runMutation(component.lib.reset, { name: id }),
					);
					if (outcome === "running") throw runningError(id, "reset");
				} else {
					const runId = args.runId;
					const out = await retryTransient(() =>
						ctx.runMutation(component.lib.cancel, { runId }),
					);
					if (out !== null && typeof out === "object" && "ended" in out) {
						throw new Error(`Run ${runId} already ended; nothing to cancel.`);
					}
					if (out !== null && typeof out === "object") {
						throw new Error(
							`Run ${runId} is no longer running; run ${out.other} started since. Nothing was canceled. ` +
								`To stop run ${out.other}, run ${cli("cancel")} again.`,
						);
					}
				}
				return await summarize(ctx, list);
			},
		}) as Migrations<S[number]>["functions"]["operate"];

		return {
			functions: { apply, status, operate, runStep },
			ids: steps.map((s) => s.id) as Id[],
			step: ((id: string) => {
				const s = byId.get(id);
				if (!s) throw new Error(`No Step "${id}" in the Plan.`);
				return s;
			}) as Migrations<S[number]>["step"],
			async isReady(ctx, id) {
				const s = byId.get(id);
				if (!s) throw new Error(`No Step "${id}" in the Plan.`);
				return await ctx.runQuery(component.lib.isReady, {
					name: id,
					version: s._def.version,
				});
			},
			async status(ctx) {
				return await summarize(ctx, planEntries(""));
			},
			async start(ctx, opts = {}) {
				const all = await entries();
				const rebuildIds = targets(all, opts);
				const runId = randomId();
				// From an action, a lost write conflict surfaces here and is tried
				// again. From a mutation, `prepare` is part of the caller's
				// transaction: a conflict shows only at its commit, and Convex runs
				// the whole mutation again, so the retry never waits there. A write
				// throttle is not retried, because a mutation cannot wait.
				const prep = await retryTransient(
					() =>
						ctx.runMutation(component.lib.prepare, {
							plan: all,
							runId,
							mode: "background",
							only: opts.only,
							rebuild: rebuildIds,
							budgetMs,
						}),
					isWriteConflict,
				);
				if (prep.unfinishedOrphans.length)
					throw orphanError(prep.unfinishedOrphans);
				return { runId };
			},
		};
	}

	return { migrate, once, seed, rebuild, plan, adopt };
}

function makeStep<Id extends string, D>(
	id: Id,
	kind: Kind,
	definition: D,
	def: StepDef,
): Step<Id, D> {
	return { id, kind, definition, _def: def };
}

function iso(ms: number | null): string {
	return ms === null ? "unknown" : new Date(ms).toISOString();
}

function randomId(): string {
	return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const UNSET = "<unset>";
const MAX_VALUE_CHARS = 2_000;

/**
 * Dry Run changes as plain JSON. A field set to undefined (removed by a
 * patch) shows as "<unset>". A value over 2,000 characters of JSON is cut
 * to a preview string, so the changes fit in the error that carries them.
 */
function toJson(changes: DryRunChange[]): any {
	return changes.map((c) => {
		const json = JSON.stringify(c.value ?? null, (_k, v) =>
			v === undefined ? UNSET : typeof v === "bigint" ? v.toString() : v,
		);
		const value =
			c.value === undefined
				? undefined
				: json.length > MAX_VALUE_CHARS
					? `${json.slice(0, MAX_VALUE_CHARS)}... (${json.length} characters)`
					: JSON.parse(json);
		return {
			table: c.table,
			op: c.op,
			id: c.id,
			...(value === undefined ? {} : { value }),
		};
	});
}

/** Wrap `ctx.db` so a Dry Run records every write, to every table. */
const PAGINATE_ERROR = /paginated quer/i;

function recordingDb<DB extends object>(
	db: DB,
	tables: string[],
	changes: DryRunChange[],
): DB {
	const target = db as any;
	const tableOf = (id: string) =>
		tables.find((t) => target.normalizeId(t, id) !== null) ?? "unknown";
	// Convex accepts both `patch(id, value)` and `patch(table, id, value)`.
	const split = (args: any[], withValue: boolean) => {
		const explicit = withValue ? args.length === 3 : args.length === 2;
		return explicit
			? { table: args[0] as string, id: args[1] as string, value: args[2] }
			: { table: tableOf(args[0]), id: args[0] as string, value: args[1] };
	};
	return new Proxy(target, {
		get(obj, prop) {
			if (prop === "insert") {
				return async (table: string, value: unknown) => {
					const id = await obj.insert(table, value);
					changes.push({ table, op: "insert", id, value });
					return id;
				};
			}
			if (prop === "patch" || prop === "replace") {
				return async (...args: any[]) => {
					const { table, id, value } = split(args, true);
					await obj[prop](...args);
					changes.push({ table, op: prop, id, value });
				};
			}
			if (prop === "delete") {
				return async (...args: any[]) => {
					const { table, id } = split(args, false);
					await obj.delete(...args);
					changes.push({ table, op: "delete", id });
				};
			}
			const value = Reflect.get(obj, prop);
			return typeof value === "function" ? value.bind(obj) : value;
		},
	}) as DB;
}
