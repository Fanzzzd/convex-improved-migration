# 12. Steps are data, not functions

Date: 2026-11-10

## Status

Accepted. Implemented in 0.1.0. Revises ADRs 1, 5, 8, 9, 10 and 11.

## Context

The first draft kept upstream's structure: every Step is an exported internal
mutation, and the Plan is a list of `internal.migrations.*` references. That
structure causes most of the remaining friction:

- Each Step is written twice: once as an export, once in the list.
- A module that exports functions and also reads `internal.migrations` forms a
  type cycle. Upstream users hit TS2589 (upstream #28).
- Identity is the function path, so moving a file re-runs a Step unless the
  author remembers a `name` override.
- Every Step is also a CLI-callable function, which creates a second way to run
  work with different semantics (upstream's `_runInteractive`).
- Readiness takes a function reference, so a reader module imports `internal`
  just to name a migration.

Flyway, Liquibase and Mongock identify a change by a declared id, not by code
location. Prisma 8 pairs each data transform with a `check` that finds rows
still needing work.

## Decision

1. Steps are plain objects built by `m.seed`, `m.migrate`, `m.once` and
   `m.rebuild`. The first argument is a required Step id string, unique in the
   Plan, checked when `m.plan` runs. The id is the key in component state.
2. The Plan is `m.plan([...steps])`. It returns the `migrations` object. Its
   `functions` are the four registered functions: the action `apply`, the query
   `status`, the action `operate` and the internal mutation `runStep`. Its
   helpers for app code are `isReady`, `status`, `start`, `step` and `ids`:

   ```ts
   const m = defineMigrations(components.migration, { schema });

   export const migrations = m.plan([
     m.seed("countries", upsertCountries),
     m.migrate("2026-11-10-user-role", {
       table: "users",
       needs: (u) => u.role === undefined,
       run: (ctx, u) => ({ role: "member" }),
     }),
     m.once("2026-11-10-default-project", insertDefaultProject),
     m.rebuild("order-counters", {
       version: 2,
       table: "orders",
       clear: "orderCounters",
       run: bumpCounter,
     }),
   ]);

   export const { apply, status, operate, runStep } = migrations.functions;
   ```

3. `runStep` is the only function the component calls back. Every Batch calls it
   through a function handle with `{ step, op, cursor, batchSize }`, where `op`
   is `batch`, `verify`, `clear` or `run`; it dispatches to the in-memory Step
   definition. `m.plan` builds its reference with
   `makeFunctionReference("<module>:runStep")`; `module` defaults to
   `"migrations"` and can be set on `defineMigrations`. Apply creates the
   function handle on every call. When that fails, the error says to export
   `runStep` and which `module` to set.
4. `migrations.isReady(ctx, id)` is a plain helper (not a registered function).
   `id` is typed as the union of the Plan's Step ids through `const` type
   parameters on the Step builders and on `m.plan`, so a typo fails `tsc`.
5. One verb: every body is `run`. `run(ctx)` for Seeds and `m.once` Migrations;
   `run(ctx, doc)` for table Steps, returning an optional patch (upstream's
   `migrateOne` contract). `needs(doc)` selects documents that still need work
   (ADR 8).
6. Step bodies can live in any file. A file that only builds Step objects
   imports `m` and never `internal`, so splitting a large Plan cannot create a
   type cycle.

Alternatives considered:

- Keep exported functions plus an `id` option (first draft). Rejected: keeps the
  double declaration, the type cycle and the second door.
- Generate one registered function per Step from the Plan. Rejected: Convex
  registers exports by name, so the app author would still destructure one
  export per Step.
- Infer the `runStep` path at runtime. Not possible: a Convex function cannot
  read its own path (`ctx.meta.getFunctionName()` does not exist; the upstream
  maintainer asked for it in PR #31).

## Consequences

- A Step is written once. Reordering, moving or splitting files never changes
  identity.
- There is exactly one way to run work: Apply, through the `apply` function, the
  CLI that calls it, or `migrations.start`.
- Dashboard logs show `runStep` for every Batch. `runStep` prints one console
  line per `batch` call with the Step id and the counts:
  `[migration] <id>: batch of N (P processed, S skipped)`. It prints nothing for
  `verify`, `clear` and `run` calls.
- `module` must match the file that exports the four functions. The default
  covers `convex/migrations.ts`; other locations need one option, and the CLI
  takes the same value as `--module`.
- Moving from upstream changes more than a rename: each
  `migrations.define({ table, migrateOne })` becomes
  `m.migrate("<id>", { table, run })`, and its export and list entry disappear.
  For Steps still pending somewhere, the id should be the upstream function name
  (for example `"migrations:backfillX"`) so Adoption matches (ADR 9).
