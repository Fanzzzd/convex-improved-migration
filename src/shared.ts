import { v, type Infer } from "convex/values";

/** What decides whether a Step runs on a given Apply. See CONTEXT.md. */
export const kindValidator = v.union(
	v.literal("migration"),
	v.literal("seed"),
	v.literal("rebuild"),
);
export type Kind = Infer<typeof kindValidator>;

export const viaValidator = v.union(
	v.literal("ran"),
	v.literal("marked"),
	v.literal("adopted"),
);
export type Via = Infer<typeof viaValidator>;

export const stateValidator = v.union(
	v.literal("pending"),
	v.literal("running"),
	v.literal("done"),
	v.literal("failed"),
);
export type StepState = Infer<typeof stateValidator>;

export const phaseValidator = v.union(
	v.literal("clear"),
	v.literal("migrate"),
	v.literal("verify"),
);
export type Phase = Infer<typeof phaseValidator>;

/** One Step of the Plan, as the client describes it to the component. */
export const planEntryValidator = v.object({
	/** The Step id: the key of its state in the component. */
	name: v.string(),
	/** Function handle of the app's `runStep` mutation. Empty in queries. */
	handle: v.string(),
	kind: kindValidator,
	/** A run-once handler Migration or a Seed: one call, no table. */
	oneShot: v.boolean(),
	version: v.optional(v.string()),
	verify: v.boolean(),
	clear: v.boolean(),
	/** The clear is one function call, so a smaller Batch does not help it. */
	clearOnce: v.optional(v.boolean()),
	batchSize: v.number(),
});
export type PlanEntry = Infer<typeof planEntryValidator>;

export const stepErrorValidator = v.object({
	message: v.string(),
	batch: v.number(),
	batchSize: v.number(),
	processed: v.number(),
	phase: v.optional(phaseValidator),
});
export type StepError = Infer<typeof stepErrorValidator>;

/** Arguments of the app's `runStep` mutation. Only the component calls it. */
export const runStepArgsValidator = {
	step: v.string(),
	op: v.union(
		v.literal("batch"),
		v.literal("verify"),
		v.literal("clear"),
		v.literal("run"),
	),
	cursor: v.optional(v.union(v.string(), v.null())),
	batchSize: v.optional(v.number()),
	dryRun: v.optional(v.boolean()),
	/** Dry Run only: run the Step's clear before the Batch, in one transaction. */
	clearFirst: v.optional(v.boolean()),
};
export type StepOp = "batch" | "verify" | "clear" | "run";
export type RunStepArgs = {
	step: string;
	op: StepOp;
	cursor?: string | null;
	batchSize?: number;
	dryRun?: boolean;
	clearFirst?: boolean;
};

export type BatchResult = {
	cursor: string | null;
	isDone: boolean;
	processed: number;
	skipped: number;
};

export type VerifyResult = {
	cursor: string | null;
	isDone: boolean;
	notMigrated: number;
	samples: string[];
};

export type ClearResult = { cursor: string | null; isDone: boolean };

/** One write recorded during a Dry Run. */
export type DryRunChange = {
	table: string;
	op: "insert" | "patch" | "replace" | "delete";
	id: string | null;
	value?: unknown;
};

export const DRY_RUN = "DRY_RUN";

/**
 * A driver renews the Lease at most this often. Every command reads the
 * Lease, so writing it on each Batch would make them lose write conflicts
 * against a busy driver.
 */
export const HEARTBEAT_MS = 15_000;
export const LEASE_TTL_MS = 2 * 60 * 1000;
export const MAX_SAMPLES = 10;
/** Background restarts without a new Batch before the watchdog gives up. */
export const MAX_RESTARTS = 3;

/** Backoff the driver did before an `advance` call, logged as an Event. */
export const throttleValidator = v.object({
	retries: v.number(),
	waitedMs: v.number(),
	message: v.string(),
});
export type Throttle = Infer<typeof throttleValidator>;

/** How a run ended, as its run record keeps it. */
export const runOutcomeValidator = v.union(
	v.literal("done"),
	v.literal("failed"),
	v.literal("canceled"),
	v.literal("stalled"),
	v.literal("taken over"),
);
export type RunOutcome = Infer<typeof runOutcomeValidator>;

export const failureValidator = v.object({
	name: v.string(),
	kind: kindValidator,
	error: stepErrorValidator,
	later: v.array(v.string()),
});
export type Failure = Infer<typeof failureValidator>;

export const advanceResultValidator = v.union(
	v.object({ status: v.literal("done") }),
	v.object({ status: v.literal("progress"), current: v.string() }),
	v.object({ status: v.literal("preempted") }),
	v.object({ status: v.literal("canceled") }),
	v.object({ status: v.literal("failed"), failure: failureValidator }),
);
export type AdvanceResult = Infer<typeof advanceResultValidator>;

export const abortResultValidator = v.union(
	v.object({ retry: v.literal(true) }),
	v.object({
		retry: v.literal(false),
		failure: v.union(failureValidator, v.null()),
	}),
	/** The run no longer holds the Lease: canceled, or another run took it. */
	v.object({
		retry: v.literal(false),
		stopped: v.union(v.literal("canceled"), v.literal("preempted")),
	}),
);
export type AbortResult = Infer<typeof abortResultValidator>;

/**
 * Whether apply starts a Step that needs work over, or resumes it from its
 * saved progress. apply (through startRow), the dry run and status all ask
 * this one function, so they cannot disagree.
 *
 * A Rebuild starts over when its version changed, a rebuild is requested, a
 * snapshot import is suspected (apply then requests the rebuild), or it was
 * done. A Seed starts over in every new run. Any Step without saved progress
 * starts at the beginning. `why` names the cause for a Rebuild that starts
 * over, else it is null.
 */
export function startOver(
	entry: { kind: Kind; version?: string | null },
	row: {
		state: string;
		version?: string | null;
		rebuildRequested?: boolean;
		runId?: string | null;
	} | null,
	hasProgress: boolean,
	context: { runId?: string; importSuspected?: boolean } = {},
): { over: boolean; why: string | null } {
	if (!row) return { over: true, why: null };
	if (entry.kind === "rebuild") {
		const was = row.version ?? null;
		const now = entry.version ?? null;
		if (was !== now)
			return { over: true, why: `version ${was ?? "none"} -> ${now}` };
		if (row.rebuildRequested) return { over: true, why: "rebuild requested" };
		if (context.importSuspected)
			return { over: true, why: "snapshot import suspected" };
		if (row.state === "done") return { over: true, why: "rebuild" };
	}
	if (entry.kind === "seed" && row.runId !== context.runId)
		return { over: true, why: null };
	return { over: !hasProgress, why: null };
}

export type LoopOutcome =
	| { status: "done" }
	| { status: "failed"; failure: Failure }
	| { status: "preempted" }
	| { status: "canceled" }
	/**
	 * Past the deadline. `throttled` holds waits no `advance` recorded yet, for
	 * an Event. `retries` counts throttle retries in a row, also those of
	 * earlier Drivers; the next Driver goes on counting from it.
	 */
	| { status: "budget"; throttled?: Throttle; retries: number };

const MAX_THROTTLE_RETRIES = 8;

/**
 * A CLI command that names a Step, for hints. An id that starts with "-"
 * goes after `--`, so the CLI reads it as an id; options in `tail` then go
 * before the `--`.
 */
export function stepCommand(command: string, id: string, tail = ""): string {
	return id.startsWith("-")
		? `${command}${tail} -- ${id}`
		: `${command} ${id}${tail}`;
}

/**
 * A global that `register` from convex-improved-migration/test sets. The
 * component then arms its sentinel with the longest delay setTimeout can
 * hold, because convex-test schedules with setTimeout.
 */
export const SHORT_SENTINEL_FLAG = "__convexImprovedMigrationShortSentinel";

/** Deployment write throttles, for example "Too many writes per second". */
export function isRateLimit(message: string): boolean {
	return /per second|rate limit/i.test(message);
}

/** A mutation that kept conflicting with other writes after Convex's own retries. */
export function isWriteConflict(message: string): boolean {
	return /OptimisticConcurrencyControlFailure|changed while this mutation was being run/i.test(
		message,
	);
}

/**
 * The first line of an error plus its first stack frame, without the
 * runtime's "Uncaught Error:" prefix.
 */
export function cleanError(raw: string): string {
	const lines = raw.split("\n").map((l) => l.trimEnd());
	const head = (lines[0] ?? "").replace(/^(Uncaught )?(Convex)?Error: /, "");
	const frame = lines.find((l) => /^\s+at /.test(l));
	return frame ? `${head} (${frame.trim()})` : head;
}

export function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Retry a short mutation that lost a write conflict or hit a per-second write
 * throttle, for example taking the Lease while a busy driver renews it. Only
 * for actions: it waits between tries.
 */
export async function retryTransient<T>(
	run: () => Promise<T>,
	transient: (message: string) => boolean = (m) =>
		isWriteConflict(m) || isRateLimit(m),
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await run();
		} catch (e) {
			if (attempt >= 5 || !transient(errorText(e))) throw e;
			await sleep(100 * 2 ** attempt + Math.random() * 100);
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The driver. The foreground `apply` action and the background `drive` action
 * both run this loop: one `advance` per unit of work until the Plan is Done,
 * a Step fails, another run takes over, or the deadline passes.
 *
 * An error that aborts a whole `advance` cannot be recorded inside it, so the
 * loop hands it to `recordAbort`, which halves the Batch or fails the Step.
 * A per-second write throttle rejects every write, including the one
 * `recordAbort` would make, and a smaller Batch does not lower bytes per
 * second. The loop waits and retries the same unit instead.
 */
export async function runLoop(
	io: {
		advance: (throttled?: Throttle) => Promise<AdvanceResult>;
		/** `throttled` holds waits that no `advance` recorded. */
		recordAbort: (
			message: string,
			throttled?: Throttle,
		) => Promise<AbortResult>;
	},
	deadline: number,
	/** Throttle retries in a row that earlier drivers of this run made. */
	retriesSoFar = 0,
): Promise<LoopOutcome> {
	let throttled = retriesSoFar;
	let pending: Throttle | undefined;
	const budget = (): LoopOutcome =>
		pending
			? { status: "budget", throttled: pending, retries: throttled }
			: { status: "budget", retries: throttled };
	const backOff = async (e: unknown) => {
		const message = errorText(e);
		const transient = isRateLimit(message) || isWriteConflict(message);
		if (!transient || throttled >= MAX_THROTTLE_RETRIES) return false;
		const ms = Math.min(1000 * 2 ** throttled, 16_000);
		await sleep(ms);
		throttled++;
		pending = {
			retries: (pending?.retries ?? 0) + 1,
			waitedMs: (pending?.waitedMs ?? 0) + ms,
			message: (message.split("\n")[0] ?? "")
				.replace(/^(Uncaught )?Error: /, "")
				.slice(0, 200),
		};
		return true;
	};
	for (;;) {
		let result: AdvanceResult;
		try {
			result = await io.advance(pending);
			throttled = 0;
			pending = undefined;
		} catch (e) {
			if (await backOff(e)) {
				// A foreground apply must hand over on time, also while it waits.
				if (Date.now() >= deadline) return budget();
				continue;
			}
			let recorded: AbortResult;
			try {
				recorded = await io.recordAbort(errorText(e), pending);
				pending = undefined;
			} catch (e2) {
				if (await backOff(e2)) {
					if (Date.now() >= deadline) return budget();
					continue;
				}
				throw e2;
			}
			if (recorded.retry) continue;
			if ("stopped" in recorded) return { status: recorded.stopped };
			if (recorded.failure)
				return { status: "failed", failure: recorded.failure };
			throw e;
		}
		if (result.status !== "progress") return result;
		// Checked after the unit, so every driver makes progress.
		if (Date.now() >= deadline) return budget();
	}
}
