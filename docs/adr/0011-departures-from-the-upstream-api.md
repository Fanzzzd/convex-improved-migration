# 11. Departures from the upstream API

Date: 2026-11-10

## Status

Accepted. Implemented in 0.1.0. Revised on 2026-11-10 by ADR 12 (clean-slate
API).

## Context

Read at convex/migrations main `202fa4a`. ADR 12 replaces upstream's structure
(exported migration functions plus a runner list). This ADR records each
remaining difference and what is kept.

## Decision

Kept:

- The table-Step body contract: `run(ctx, doc)` returns a patch, writes through
  `ctx`, or returns nothing (upstream `migrateOne`).
- The `internalMutation` option, which is how triggers run inside Steps.
- `batchSize` and `parallelize` per table Step.
- Running one Batch per component mutation, with the app body as a
  sub-transaction, so writes and cursor commit together.

Changed:

| Upstream (index.ts / lib.ts at 202fa4a)                                                                        | Here                                                                                                               | Why                                                                |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Each migration is an exported function; the runner lists `internal.migrations.*`                               | Steps are data with ids; one `runStep` callback (ADR 12)                                                           | Write once; no type cycle; no second door                          |
| Identity = function path; moving a file re-runs                                                                | Identity = declared id                                                                                             | Stable across refactors                                            |
| `new Migrations<DataModel>(component, { schema? })`; `schema` needed only for `customRange` (index.ts 438-458) | `defineMigrations(component, { schema })`; types come from the schema                                              | One argument gives the types and the table names a dry run reports |
| Direct call routes to `_runInteractive` (index.ts 381-408)                                                     | Steps are not functions; `apply({ only })` runs one                                                                | One set of semantics                                               |
| Runtime args `fn`, `cursor`, `next`, `oneBatchOnly`, `reset`, `dryRun`, `batchSize` (shared.ts)                | `apply({ dryRun?, only?, rebuild?, wait?, resume? })`, `operate({ op: "reset", id })`, `operate({ op: "cancel" })` | Cursors and scheduling are internal                                |
| `reset: true` also resets every `next` entry (lib.ts 149-158)                                                  | `operate({ op: "reset", id })` resets that Step only                                                               | No surprise re-runs                                                |
| `cancel(name)`, `cancelAll()`                                                                                  | `operate({ op: "cancel" })`                                                                                        | One Lease, one active run                                          |
| Failure returned as a value; CLI exits 0 (log.ts)                                                              | Thrown, with next commands (ADR 3, 10)                                                                             | CI must see failure                                                |
| State partly derived from `_scheduled_functions`, `unknown` after 7 days (lib.ts 246-278)                      | State stored in the `steps` table; `stalled` is derived from the Lease                                             | Status must not decay                                              |
| `getStatus({ limit })`, default 100 newest rows (lib.ts 212-236)                                               | `status`, a query, returns every Plan Step plus Orphans                                                            | The Plan is what matters                                           |
| Dry run diffs only the primary table (upstream #16)                                                            | Dry run records writes to every table (next Batch, at most 20 changes)                                             | Backfills write elsewhere                                          |
| Only table scans fit in a runner                                                                               | `m.once(id, run)` without a table; `m.seed(id, run)`                                                               | Grants and fixes were bare mutations in the motivating app         |
| `migrateOne` + no built-in check                                                                               | `run` + optional `needs` (ADR 8)                                                                                   | Idempotency and verification in one field                          |

Considered and deferred: a page-level body `run(ctx, docs)` for batched lookups
(maintenance_tasks `in_batches`); runtime arguments (upstream #30).

## Consequences

- An upstream migration moves by rewriting its declaration into the Plan; the
  body is unchanged apart from the `migrateOne` to `run` rename.
- `range` uses the built-in `.paginate()` inside `runStep`. The package does not
  depend on convex-helpers. A `run` that also calls `.paginate()` works on a
  deployed backend and fails under convex-test (ADR 4).
