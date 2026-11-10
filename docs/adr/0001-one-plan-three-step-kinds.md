# 1. One Plan, three Step kinds

Date: 2026-11-10

## Status

Accepted. Implemented in 0.1.0. Revised on 2026-11-10 by ADR 12 (clean-slate
API).

## Context

The motivating app's `runAll` (`docs/research/problem-statement.md`) grew to
about a hundred entries that serve four different purposes: reference-data seeds
and permission grants, readiness flags, one-off legacy backfills, and rebuilds
of derived data after `convex import`. `@convex-dev/migrations` treats all of
them as "run once, skip by name". That is wrong for seeds (new reference data
must reach production on the next deploy) and wrong for rebuilds (a Snapshot
Import restores component status, so rebuilds are skipped exactly when they are
needed). Survey: Flyway separates versioned from repeatable migrations,
Liquibase has `runOnChange`/`runAlways`, Mongock has `runAlways`, and Rails
keeps seeds outside migrations (`industry-survey.md`, Judgment 7).

## Decision

An app declares one ordered Plan of Steps (ADR 12: Steps are data). Each Step
has one of three Kinds, and the Kind alone decides when it runs:

- `m.migrate(id, { table, run, needs?, range?, batchSize?, parallelize? })` runs
  once per deployment, batch by batch, then stays Done. `m.once(id, run)` is a
  Migration with no table: one mutation, run once (grants, single-document
  fixes).
- `m.seed(id, run)` runs on every Apply, as one mutation. Must be idempotent.
  The dev seed script can call the same `run`.
- `m.rebuild(id, { version, table, run, clear?, range?, batchSize?, parallelize? })`
  runs when its Version differs from the recorded one, when Apply is called with
  `rebuild`, or when Apply detects a Snapshot Import (ADR 6). `clear` is an app
  table name (emptied in batches first) or a function that clears the derived
  data in one mutation. A `clear` that names the Rebuild's own `table` throws
  when the Step is defined.

Steps run in Plan order. `m.plan([...])` returns the `migrations` object. Its
`functions` are the four registered functions the app exports: the action
`apply`, the query `status`, the action `operate` (markDone, reset, cancel) and
the callback mutation `runStep`. Its helpers for app code are `isReady`,
`status`, `start`, `step` and `ids`.

Out of scope for 0.1.0: runtime arguments per run (upstream #30), pause and
throttle hooks, old-client detection, read comparison during dual reads, a
page-level `run(ctx, docs)` body. Each can be added later without changing this
shape.

## Consequences

- Seeds stop living in the migration list and stop being duplicated in dev seed
  scripts.
- A Rebuild is never confused with a one-off Migration, so it can be forced
  after an import without resetting unrelated history.
- Three Kinds is the whole taxonomy. Readiness flags are not a Kind; they are
  replaced by Readiness queries (ADR 5).
- Seeds and `m.once` Migrations are limited to one mutation. The component runs
  it under the same limits as a Batch (12,000 documents written, ADR 4). Larger
  work belongs in a table Migration.
