# Research part: the Convex ecosystem

Appendix of `docs/research/industry-survey.md`. Citations `[Cn]` refer to the
Sources list at the end of this file.

Date: 2026-11-10. Scope: the Convex slice of the survey in
`docs/research/industry-survey.md`. This part extends
`docs/research/baseline-prior-art.md`, which covered `@convex-dev/migrations`
v0.3.6 at a high level. Facts already stated there are not repeated unless the
source changed.

Pinned sources read for this part:

| Repo                                                         | Ref                                                                            | Date       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------- |
| convex/migrations                                            | main `202fa4a` (latest release tag `v0.3.7` = `2e1cf91`, `v0.3.6` = `35e143e`) | 2026-11-08 |
| convex/convex-helpers                                        | `964f2d4`                                                                      | 2026-11-05 |
| convex/workpool                                              | `1360c71` (tag v0.4.15)                                                        | 2026-11-09 |
| convex/workflow                                              | `15b2b2d` (tag v0.4.10)                                                        | 2026-11-10 |
| convex/aggregate                                             | `7583a1e` (tag v0.3.4)                                                         | 2026-11-02 |
| convex/agent-skills                                          | `f60629d`                                                                      | 2026-10-29 |
| convex/convex-backend (docs source, CLI, Rust import/export) | `b9f41c0`                                                                      | 2026-11-10 |

The `get-convex` GitHub org has been renamed to `convex`; the API redirects
every repo above [C44].

## 1. `@convex-dev/migrations`

### 1.1 Releases and unreleased changes

- v0.3.7 (tagged 2026-10-09) only changes the `/test` entrypoint for
  convex-test's `defineTestApp` [C1]. `git diff v0.3.6..v0.3.7 -- src` touches
  only `src/test.ts` and `src/component/lib.test.ts`.
- Main has two behaviour changes since v0.3.7 that are not released [C2]:
  - The `runner` now forwards `oneBatchOnly` to the component. In v0.3.6 and
    v0.3.7 the runner accepted the flag but dropped it, so
    `{oneBatchOnly: true}` started the normal async chain (issue #69, fixed by
    PR #74) [C2][C3].
  - `migrate` now treats an explicit `cursor: null` as a reset even when the
    saved cursor is already `null`. Before this, `reset: true` after a
    first-batch failure kept the old `latestStart` (PR #76) [C2][C4].
- Open maintainer PRs: #77 (docs split into six pages) [C5], #78 (print the
  component's real mount path in CLI hints; adds a `lib:componentPath` query)
  [C6], #24 (stale since 2025-11, "inline runner") [C7], #48 (WIP tests). PR #72
  (use built-in `.paginate()` in components) was closed; its body says it
  depends on an upcoming Convex release that "lets components call `.paginate()`
  once per transaction" [C8].

### 1.2 Public API on main

There is no `defineMigration` function. The maintainer floated a standalone
`defineMigrations`/`defineRunner` as a fix for TS2589 type cycles in issue #28,
but it does not exist [C9]. The API is a class plus one free function.

`new Migrations(component, options)` [C10, index.ts 80-119]. Options:
`internalMutation` (custom builder, also the way to make triggers run inside
migrations [C11]), `defaultBatchSize` (default 100), `migrationsLocationPrefix`,
`schema` (required for `customRange`).

`migrations.define({...})` returns an internal mutation [C10, index.ts 343-553]:

- `table`, `migrateOne(ctx, doc)`. If `migrateOne` returns a non-empty object it
  is applied with `ctx.db.patch` [C10, 479-492].
- `customRange(q)` narrows the query, for example with an index. It needs
  `schema` because pagination uses the convex-helpers `paginator` [C10,
  438-458].
- `batchSize` per migration. Runtime `batchSize` overrides it [C10, 364-367,
  410].
- `parallelize: true` runs `migrateOne` for one page with `Promise.all`. Batches
  themselves stay serial [C10, 493-499][C11, README 418-428].
- Calling the defined mutation without `oneBatchOnly` (CLI, dashboard) routes to
  `_runInteractive`, the same path as `runner` [C10, 381-408]. This "call it
  directly" mode shipped in 0.3.4 [C1].
- With `oneBatchOnly` and no cursor, it defaults to a dry run of the first page
  [C10, 411-426].
- `dryRun` runs one page, compares before and after for the primary table, logs
  up to 10 changes, then throws a `ConvexError({kind: "DRY RUN"})` to roll back
  [C10, 505-539]. There is no write trace for other tables. A 2026-01-30 comment
  on issue #16 claims a "write trace" was added to `src/client/index.ts`;
  neither main nor git history (`git log -S"Write trace"`) contains it [C12].

`migrations.runner(fnRef | fnRef[] | undefined)` returns an internal mutation
[C10, 146-180]. A list becomes the first migration plus `next` handles. With no
argument it accepts `{fn: "file:name"}`.

Runtime args for every runner or direct call: `fn`, `cursor`, `batchSize`,
`dryRun`, `next` (string names), `reset`, `oneBatchOnly` [C13, shared.ts 3-11].
There are no user-defined arguments (see 1.6, issue #30).

Programmatic calls:

- `runOne(ctx, fnRef, {cursor, batchSize, dryRun, reset})` [C10, 589-614].
- `runSerially(ctx, fnRefs)`. No dry run, batch size or reset options [C10,
  651-678].
- `getStatus(ctx, {migrations?, limit?})`. With names it returns a placeholder
  row (state `unknown`) for unknown names. Without names it returns the newest
  100 rows by creation time [C10, 687-704][C14, lib.ts 209-244].
- `cancel(ctx, name | fnRef)` and `cancelAll(ctx)` [C10, 716-737].
- `runToCompletion(ctx, component, fnRef, {name, cursor, batchSize, dryRun})`, a
  free function for actions. It loops `migrate` with `oneBatchOnly: true`. It
  returns when `isDone`, throws `status.error` on failure, and throws if the
  cursor does not advance [C10, 779-838].

Component functions callable from the CLI with `--component migrations`:
`lib:migrate`, `lib:getStatus`, `lib:cancel`, `lib:cancelAll`, `lib:clearAll`
[C14]. `lib:migrate` rejects any `fnHandle` that does not start with
`function://`, so only app code can start work [C14, 52-59]. There is still no
API that records a migration as done without running it, and no baseline
command. Searches of the upstream repo's issues and PRs for "baseline", "prune",
"mark as done", "wait" and "snapshot" return nothing relevant (searched
2026-11-10).

### 1.3 State table

One table, `migrations`, with indexes `name` and `isDone` [C15, schema.ts 4-18]:

```ts
name: v.string(), cursor: v.union(v.string(), v.null()), isDone: v.boolean(),
workerId: v.optional(v.id("_scheduled_functions")), error: v.optional(v.string()),
processed: v.number(), latestStart: v.number(), latestEnd: v.optional(v.number()),
```

- The key is the function name from `getFunctionName`, for example
  `migrations:foo` [C10, 226, 599]. Moving or renaming the function creates a
  new key, so the migration runs again.
- The status `state` is derived, not stored: `success` if `isDone`; `failed` if
  `error` is set or the worker's scheduled function failed; then `canceled`,
  `inProgress`, or `unknown` from the `_scheduled_functions` row [C14, 246-278].
- Scheduled function results stay available for 7 days after completion [C27,
  scheduled-functions.mdx 125]. A migration whose last worker crashed without
  writing `error` therefore reads `failed` for about 7 days, then `unknown`.
  This is inferred from [C14] and [C27]; I did not observe it.
- `next` and `batchSize` in the status come from the pending worker's arguments,
  not from the table [C14, 274-276]. A finished or failed series does not
  remember what its `next` list was.

### 1.4 Execution, failure and resume

How one `migrate` call works [C14, 43-207]:

1. It gets or inserts the state row (lines 60-74).
2. If the caller passed a cursor different from the saved one, or
   `cursor: null`, it checks the worker. If a worker is pending or running, it
   returns without doing work. Otherwise an explicit cursor resets `isDone`,
   `processed` and the timestamps (lines 76-102).
3. If not done, it runs one batch by calling the app's migration through the
   function handle with `ctx.runMutation` (lines 113-127). That call is a
   sub-transaction. If it throws, only its writes roll back and the caller can
   catch it [C23, using.mdx 108-121][C24, understanding.mdx 64-72].
4. It schedules the next batch with `runAfter(0)`. When the migration is done,
   it scans `next` for the first name that is not `isDone` and schedules it
   (lines 129-174).
5. The `catch` stores `error`, clears `workerId`, and still patches the row and
   returns (lines 175-196).

Failure recording on main:

- A failure inside `migrateOne` is caught at step 3 and persisted as `error`.
  This includes the first batch. The upstream repo's own test asserts
  `state: "failed"`, `processed: 0` after a first-batch failure through `runOne`
  [C16, reset.test.ts 25-55].
- The runner does not throw on failure. It returns a log object whose `Status`
  is `Migration failed: ...` [C17, log.ts 25-26, 83]. `npx convex run` exits
  with code 1 only when the function throws [C36, run.ts 56-136]. So a failing
  migration started from the CLI exits 0, even on the first batch. Only
  `runToCompletion` turns a failure into a thrown error [C10, 827-829].
- Failures that abort the outer `migrate` transaction cannot be caught there:
  OCC retries exhausted, the 1 s user-code limit, transaction limits counted at
  the outer boundary. PR #57 (third-party, open) lists these cases and adds an
  action wrapper to observe them [C18]. For a scheduled batch the worker's
  `_scheduled_functions` row then shows `failed`, but no error text is written
  to the table. For the first batch started from the CLI, the whole runner
  mutation rolls back and nothing is written. This is the remaining part of
  issue #5.
- Issue #5 is still open. The maintainer wrote in 2024 that persisting the
  failure trades off against seeing the error directly. He also proposed the
  sub-transaction workaround that main now uses [C19].

Resume:

- Calling again with no cursor resumes from the saved cursor. Partial progress
  resumes, and done migrations are skipped [C11, README 206-218, 264-278].
- A failed or canceled migration in a series stops the series. The docstrings
  say "Call the series again to retry"; `runOne` on the failed member "will not
  resume the series" [C10, 568-572, 630-634].
- Since 0.3.6, `runner`, `runOne` and `runSerially` read status from a stale
  snapshot first. If any name in the requested series is `inProgress`, they
  no-op [C10, 182-218, 253-270][C1]. PR #77 documents this: "The existing worker
  continues its original series. To start a different series, call it again
  after the active migration finishes" [C5, team-workflows.mdx 60-63].
- `reset: true` restarts the named migration and every `next` entry [C14,
  149-159][C11, README 213-215].
- Cursors are tied to the query shape. Changing `customRange` or the table makes
  the saved cursor invalid. The error message tells the user to re-run with
  `cursor: null` [C10, 467-477]. The maintainer gave the same advice in issue
  #11 [C20].

### 1.5 Waiting and CI

- The README and PR #77 recommend
  `npx convex deploy --cmd 'npm run build' && npx convex run convex/migrations.ts:runAll --prod`.
  Their stated reason: "because already-completed migrations are skipped, the
  only migrations that actually do work are the new ones" [C5,
  team-workflows.mdx 79-91][C11, README 357-364].
- The only progress tools are `lib:getStatus --watch` and `runToCompletion` [C5,
  running-migrations.mdx 121-130]. `convex run --watch` only works on queries
  [C25, run.mdx 51]. It streams until interrupted; it does not exit when a
  condition is met.
- PR #24 (open, maintainer, last touched 2025-11) would turn `runner` into an
  internal action. With `{inline: true}` it would run the whole series to
  completion in that action [C7]. This is the closest upstream work on "wait for
  the series".
- In issue #14 the maintainer explains why Convex has no built-in blocking
  migrations. Convex has "a philosophy of not providing blocking migrations -
  not pausing your deployment to do a potentially unbounded amount of work
  before changing the code over". Also: "Our philosophy is to not build
  something as a fundamental primitive if it can be composed as a library on
  top" [C21].

### 1.6 Open issues and PRs, with maintainer positions

- #5, first-batch failure not persisted (open, maintainer-filed). Covered in
  1.4. Main persists `migrateOne` failures through the sub-transaction catch.
  Outer-transaction aborts are still lost [C19][C16].
- #16, dry run should show writes to other tables (open). No maintainer reply.
  The only reply's "write trace" claim is not true on main [C12].
- #30, runtime arguments (open, filed by xixixao, a Convex engineer). The
  maintainer sees "two separate types of args": ones that parametrize
  `customRange`, and ones the migration body reads. He notes environment
  variables are "not encoded into the run". He also says "Maybe a
  'backfill/livefill' component is more idiomatic, but not the worst thing to
  have this be more capable" [C22].
  - PR #31 implements this. It adds `args: v.optional(v.any())` to the schema
    and runtime args, passes `args` to `customRange` and the batch, and keys the
    status row by name plus a deterministic serialization of `args` [C26].
  - The PR author writes that this "moves the migrations towards workflows". He
    questions whether "run something durably over an index range" and "run a
    thing I'll call 'foo' once" should be separate abstractions [C26].
  - The maintainer wants `ctx.meta.getFunctionName()` so self-referential
    runners are less awkward [C26].
- #77, docs (open, maintainer). It restates the running-list workflow and the
  skip-completed model [C5]. It does not mention pruning, baselines, import, or
  fresh deployments. `getting-started.mdx` lists the five-step widen, migrate,
  narrow flow and notes the narrowing push "will only succeed once all the data
  matches the new schema" [C5, getting-started.mdx 106-115].
- #57, adaptive batch sizing (open, third-party). It reads
  `getTransactionMetrics()` after each batch, targets 50% use of the tightest
  metric, halves the batch on recognized limit or OCC failures, and supports
  several `customRange` ranges [C18]. No maintainer review is recorded.
- #59, a `create` CLI that scaffolds rename-field and rename-table migrations
  (open). The maintainer suggested this direction on convex-backend#477 and
  called it "the more promising direction vs. the dashboard tooling" [C27a].
- #26, `forceContinue` (closed by the maintainer: "this doesn't work") [C28].
- #28, TS2589 when several files import one `Migrations` instance. The
  maintainer's workaround is one instance per file, or a file that exports the
  instance but no functions [C9].

## 2. convex-helpers `server/migrations`

The README now says to use the component instead: "there is now a migration
component ... The component has the benefit of not needing to add any tables to
your schema" [C29, README 188-200].

API [C30]:
`makeMigration(internalMutation, {migrationTable?, defaultBatchSize?})` returns
`migration({table, migrateOne, customRange?, batchSize?})`. It also has
`startMigration`, `startMigrationsSerially`, `getStatus` and `cancelMigration`
(lines 203, 533, 575, 605, 664).

Differences from the component:

- State lives in an app table, `migrationsTable`, that the user adds to the app
  schema. Fields: `name`, `table`, `cursor`, `isDone`, `workerId`, `processed`,
  `latestStart`, `latestEnd`. There is no `error` field [C30, 128-146].
  Persistence is optional; without a table there is no status [C30, 336-366].
- The batch runs in the same transaction as the state update [C30, 370-411]. A
  failing batch rolls back the state too, so failures are never recorded. The
  component's sub-transaction design (1.4) fixes this.
- It stores `table` and refuses to resume when the table differs [C30, 353-366].
- Batches schedule the app migration function itself by name
  (`migrationRef(args.fn)`). It uses no function handles [C30, 448-478].
- Because state is an app table, it is a root-level table for import and export.
  It is replaced or cleared by `--replace-all` like any app table (see 6.4).

## 3. Workpool and Workflow

### Workpool [C31]

- It is like `ctx.scheduler.runAfter(0, ...)` but caps parallelism per pool. The
  README says to avoid more than 100 total on Pro and 20 on free, across all
  pools and workflows (README 226-229, 309-312).
- Setting `maxParallelism` to 0 at runtime pauses a pool (README 317-324).
- Retries apply to actions only, with exponential backoff and jitter.
  `NonRetryableError` stops retries (README 343-377). "Mutations are not retried
  by the workpool. Convex automatically retries them on database conflicts and
  transient failures" [C32, client/index.ts 160-162].
- `onComplete` "will always be called, whether the work was successful, failed,
  or was canceled". It receives `context` passed at enqueue time (README 68-76,
  327-341).
- `pool.status(id)` returns `pending`, `running` or `finished`. "After the work
  finishes, it does not maintain any metadata" (README 231-258). Durable results
  must be written by the job or by `onComplete`.

### Workflow [C33]

- A workflow handler is a mutation that replays a journal of step results. A
  step runs as a query, mutation or action through a workpool. After each step
  completes, the handler re-runs deterministically up to the next step (README
  93-104).
- The journal is capped at `MAX_JOURNAL_SIZE = 8 << 20` bytes (8 MiB) [C34,
  shared.ts 1; step.ts 78-80; journal.ts 64-65]. The README also says steps "can
  only take in and return a total of _1 MB_". The README contradicts itself on
  the limit; the code enforces 8 MiB (README 840-850).
- Changing the steps of a running workflow (adding, removing, reordering) fails
  it with a determinism violation (README 856-860). Issue #35, "Allow
  configuring determinism validation", is open [C35].
- Action steps have no retries by default. Queries and mutations, including the
  handler, "are retried automatically by Convex on system errors" (README
  316-325).
- `step.runMutation(..., {inline: true})` shares the workflow's transaction and
  its limits (README 416-447).
- Other APIs: `onComplete`, `getStatus` (reactive in a query), `cancel`,
  `restart({from})` and `cleanup`. "Completed workflows are not automatically
  cleaned up" (README 212-267, 493-602).
- Calling a workflow from the CLI
  (`npx convex run example:exampleWorkflow '{"args": {...}}'`) creates it and
  runs the handler until the first step. It then returns the `workflowId`, or
  returns at once with `startAsync` (README 205-210)[C34a, workflowMutation.ts
  161-200]. There is no CLI wait.

Could a migration series run as a workflow? Facts that bear on it:

- One step per batch would add one journal entry per batch. A table of 1M
  documents at 100 per batch means 10,000 entries in one journal under an 8 MiB
  cap [C34].
- One action step per migration calling `runToCompletion` keeps the journal
  small. But every step is bounded by the action limit of 30 min (Convex
  runtime) or 10 min (Node) [C37]. Actions are at most once and are not retried
  unless configured [C27, 156-164][C33].
- The series list grows with each deploy. A workflow started under an older list
  that is still running when the code changes hits the determinism check [C33,
  README 856-860].
- Either way, a CLI caller still gets back only an ID and must poll status.

## 4. Aggregate and triggers: backfill and repair

- Attaching an aggregate to existing data takes four steps [C38, README
  427-445]:
  1. Switch live writes to idempotent variants (`insertIfDoesNotExist`,
     `replaceOrInsert`, `deleteIfExists`, or `idempotentTrigger`).
  2. Deploy.
  3. Backfill with a paginated `@convex-dev/migrations` migration.
  4. Switch back to the plain variants.
- The example backfill is a plain `migrations.define` whose `migrateOne` calls
  `insertIfDoesNotExist`, wrapped in its own `runner` [C39, leaderboard.ts
  246-263].
- Repair means "start over": `aggregate.clear(ctx)` or rename the component
  mount, then backfill again. The alternative paginates the source table and the
  aggregate side by side and fixes the diff [C38, README 492-505].
- Queued mode sends writes that cannot apply to a dead-letter queue, which the
  app can list and delete [C38, README 711-780].
- Triggers run in the same transaction as the write and only through wrapped
  `mutation`/`internalMutation` builders. "If you edit data in the Convex
  dashboard, the triggers won't run. If you upload data through
  `npx convex import`, the triggers won't run" [C29, README 1088-1093,
  1203-1225].
- The migrations component runs `migrateOne` through the app's own
  `internalMutation` builder. Passing a trigger-wrapped builder makes migrations
  fire triggers [C11, README 366-378].

## 5. Stack posts and agent skills

The Stack pages show no author or date. Quotes in this section came through
WebFetch, which summarizes pages, so treat them as close to verbatim (see Gaps).

- "The Secret to Migrations" [C40]: loosen, migrate, tighten.
  - "If there's no data in the table yet, change the schema freely."
  - "When you're developing locally, just clear your tables and change the
    schema without a migration."
  - Mid-migration failures: "it's usually best to roll forward rather than
    back".
- Intro to Migrations [C41]: widen to a `v.union`, dual write ("you can
  gracefully roll back"), prefer online migrations. Feature flags appear only
  for offline migrations, "by flipping a switch".
- Migrating Data with Mutations [C42]: Convex "will not let you deploy a schema
  that doesn't match the data at rest". Write the new default on new documents
  before backfilling.
- Seeding Data for Preview Deployments [C43]:
  `npx convex deploy --cmd 'npm run build' --preview-run init`. The `init`
  function "returns if data has already been added, making it safe to call many
  times". The prior note covers the rest.
- What actually happens when you push [C45]:
  - Schema validation and new index builds run as workers during `startPush`,
    and "the CLI sits there polling".
  - Only after both finish does the CLI send `finishPush`, "the moment your
    deployment stops running the old version of your code and starts running the
    new one".
  - "Every change in a push applies at once."
- Feature gating [C46]: flags live in an app `flags` table read by a query. A
  missing row returns `undefined`, and the client falls back to a hard-coded
  default. Migrations and new deployments are not discussed.
- Backend components post [C47]: component data "is included in snapshot imports
  and exports, allowing your components to restore from a backup at the same
  snapshot as the rest of your data". The source in 6.4 confirms this.
- Agent skills at `f60629d` [C48]:
  - `convex-migrate` has four steps: optional field, backfill with
    `@convex-dev/migrations`, verify, tighten. It adds "Verify row counts before
    and after".
  - `convex-migrate-rehearse` exports production, creates a preview from the
    pre-change code, imports the snapshot, rehearses widen, backfill and tighten
    there, then repeats on production. The snapshot is kept as rollback
    (`import --replace --prod`).
  - `convex-seed`: an idempotent seed `internalMutation` or `convex import`.
- `convex-migration-helper` was deleted upstream in `90ae2c3` (2026-08-01)
  [C49]. A copy vendored in a sibling project is byte-identical to the last
  upstream version, `ec1e6ba` (2026-06-22). Content:
  - It frames the work as "widen the schema, migrate the data, narrow the
    schema" across two deploys.
  - It lists "Not writing the new format before migrating" as a pitfall.
  - It gives a `verifyMigration` query that does `.withIndex(...).take(10)` on
    unmigrated rows and returns `{complete, sampleRemaining}`.
  - It warns against crons for batches.
  - Its checklist ends with "Remove migration code once confirmed stable" [C49].
- No `convex-migrate` skill or package distinct from the above was found in the
  agent-skills repo.

## 6. Platform constraints

All doc citations are to the docs source in convex-backend at `b9f41c0` [C50].

### 6.1 Transaction and time limits

- Per query or mutation: 16 MiB read, 16 MiB written, 32,000 documents scanned,
  4,096 index ranges ("calls to `db.get` and `db.query`"), 16,000 documents
  written [C37, limits.mdx 166-185]. The problem statement's "about 4,096 reads
  or writes" matches only the index-range limit. Documents scanned and written
  are higher.
- Query/mutation execution: 1 s, which "applies only to user code and doesn't
  include database operations". Actions: 30 min (Convex runtime), 10 min (Node)
  [C37, 155-160].
- Scheduler: 1,000 functions scheduled per mutation, 4 MiB per scheduled
  function's arguments, 16 MiB total per mutation, 1,000,000 outstanding [C37,
  161-165].
- `ctx.meta.getTransactionMetrics()` reports `{used, remaining}` for each limit
  [C51, writing-data.mdx 171-174].
- Scheduled mutations run "exactly once", and Convex retries internal errors.
  Actions run "at most once". Scheduling from a mutation is atomic with it.
  `runAfter(0)` adds the function to the queue at once. Results stay for 7 days
  [C27, 49, 65, 125, 156-164].

### 6.2 Schema validation and indexes on push

- "The first push after a schema is added or modified will validate that all
  existing documents match the schema. If there are documents that fail
  validation, the push will fail." `schemaValidation: false` turns this off
  [C52, schemas.mdx 286-300].
- Staged validators [C52, 302-372]:
  - Chain `.staged({...})` and deploy. Convex scans existing documents in the
    background while writes still enforce the current validator.
  - A write that fails the staged validator still succeeds but marks staged
    validation failed.
  - `npx convex deploy --dry-run` reports validating, validated or failed.
    Promoting reuses the completed scan.
  - So a narrowing push can now be pre-validated without blocking deploy.
- New indexes are backfilled before the new functions are registered. Staged
  indexes (`staged: true`) backfill in the background and cannot be queried
  until enabled [C53, indexes.mdx 60-63, 299-320].

### 6.3 CLI behaviour

- `convex deploy` steps: "When deploying to a preview deployment, it runs the
  function specified by `--preview-run`. If any step fails, the next steps do
  not run." `--preview-run` "is ignored if deploying to a production deployment"
  [C54, deploy.mdx 28-29, 82-85]. Other relevant flags: `--cmd` (lines 70-73),
  `--dry-run`, `--skip-large-indexes-check`, `--allow-unstaging-schema`
  (112-121).
- `convex run` makes one HTTP call to the function, prints the return value, and
  exits 1 only if the call throws [C36, run.ts 56-136]. It does not follow
  scheduled work. `--watch` requires a query [C25, run.mdx 51]. `--push` pushes
  code first, and `--component` targets a component (lines 71, 101).
- `convex dev --run <fn>` runs a function as step 3. `--run-component` is
  "unstable". `--once` stops on failure, and `--until-success` retries [C55,
  dev.mdx 53-81].

### 6.4 Import, export, backup and component tables

The official docs say nothing about component tables in export, backup or
`--replace-all`. The source answers it:

- Export iterates every component and writes its tables under a
  `_components/<name>/` path prefix [C56, exports/src/lib.rs 355-376, 476-487].
  Snapshot exports include component tables, the migrations component's
  `migrations` table among them.
- Import parses `_components/<name>/` prefixes back into component paths and
  prepares each component namespace [C57, parse.rs 109-114, 241-258][C58,
  snapshot_import/mod.rs 776-791]. A ZIP import restores component tables.
- `--replace-all` marks "all non-system tables" in every namespace for deletion.
  Tables in an active schema are cleared instead of deleted [C58, mod.rs
  795-798, 852-866, 1276-1288]. The CLI doc: "deleting tables that don't appear
  in the import file or the schema, and clearing tables that appear in the
  schema but not in the import file" [C59, import.mdx 59-66]. Two consequences:
  - A full production snapshot imported with `--replace-all` brings the source's
    migration status with it. Every migration done in the source reads `isDone`.
  - A ZIP without the component's folder empties the status table.
- `convex import --component <path>` exists [C59, 83-86]. `convex export` has no
  component flag [C60].
- Import keeps `_id` and `_creationTime`. "Data import creates and replaces
  tables atomically". Indexes and schema validation do not need re-backfilling
  [C61, import.mdx 106-116]. Import writes documents directly, and triggers do
  not run [C29].
- Backups contain only documents and optionally files. They exclude pending
  scheduled functions, code and environment variables [C62, backup-restore.mdx
  26-27, 118-130]. After a restore, migration rows keep `workerId` values
  pointing at scheduled functions that are not there. `getMigrationState` then
  reports `unknown` unless `error` is set [C14, 246-265]. This is inferred from
  source and not observed.

### 6.5 Components

- "They can't read your app's tables or call your app's functions unless you
  pass them in explicitly" [C63, overview.mdx 17-18]. Code in a component "can't
  read data that is not explicitly provided to it. This includes database
  tables, file storage, environment variables, scheduled functions" [C24,
  understanding.mdx 56-60].
- To call back into the app, the app passes a function handle. A component calls
  `createFunctionHandle(ref)` and then `ctx.runMutation(handle, args)`. Argument
  and return validation still run. `v.function()` checks only that a handle is
  well formed [C64, authoring.mdx 405-450]. The migrations component works this
  way [C14, 113-124].
- Each component mutation call is a sub-transaction. "You'll never have a
  component commit data but have the calling code roll back" [C24, 64-72][C23,
  using.mdx 108-121].
- Components have no `ctx.auth`, expose only public functions to the parent, and
  have isolated environment variables [C64, authoring.mdx 169, 234-263].

## 7. Readiness flags, feature gating, derived-data rebuild

- No Convex source found ties readiness flags to migrations. The feature-gating
  post stores flags in an app table, and a missing row reads as `undefined`
  [C46]. The Stack migration posts treat dual read and dual write as code paths,
  not flags [C41][C40].
- Staged validators and staged indexes are the platform's own "expand now,
  enforce later" gates. Both report status through `convex deploy --dry-run` or
  the dashboard, not through app code [C52][C53].
- Derived-data rebuild guidance comes only from aggregate: idempotent writes,
  then a backfill through the migrations component, and repair by
  clear-and-rebuild [C38][C39]. Workpool and workflow say nothing about
  rebuilds.

## Implications for a better component

Facts only. Each item names the sources it rests on.

1. Upstream status is keyed by function name and imported with snapshots. A
   rebuild-after-import step that is tracked as a normal completed migration
   will be skipped after a full-snapshot import [C10][C14][C56][C57][C58].
2. Upstream has no API to record a migration as done without running it, and no
   open issue or PR asks for one. A baseline or mark-applied operation would be
   new in the ecosystem [C14][searches in 1.2].
3. The CLI runner exits 0 when a migration fails, and `convex run` cannot follow
   scheduled work. A caller that must wait for the series, or fail on error,
   needs code that runs the whole series and throws, such as an action looping
   `oneBatchOnly` batches like `runToCompletion` or PR #24 [C10][C17][C36][C7].
   That action is bounded by 30 or 10 minutes [C37].
4. Catching the app mutation's error inside a component sub-transaction records
   `migrateOne` failures, including on the first batch [C14][C16][C23].
   Outer-transaction aborts are not caught and are visible only through
   `_scheduled_functions` for 7 days [C18][C27].
5. Batch sizing can be driven by `getTransactionMetrics()`. The relevant limits
   are 32,000 scanned, 16,000 written, 4,096 index ranges and 16 MiB each way,
   not 4,096 reads [C37][C51][C18].
6. Pushes are atomic and block until index backfill and schema validation
   finish. Staged validators let a narrowing push be validated in the background
   first [C45][C52][C53]. A narrow step can check staged-validation status
   instead of re-scanning data.
7. A component cannot read app tables or call app functions except through
   handles the app passes. Any verifier, seed or rebuild hook must be an app
   function passed as a handle [C63][C24][C64].
8. Running a growing series as one workflow conflicts with the determinism check
   and the 8 MiB journal [C33][C34].
9. Maintainer positions to respect: no blocking migrations at deploy time,
   prefer library composition [C21]. Arguments are acceptable but a
   "backfill/livefill" component may be more idiomatic [C22]. The runner should
   be callable without `fn` boilerplate [C26].
10. Triggers fire inside migrations only when the app passes a trigger-wrapped
    `internalMutation`. Import never fires them [C11][C29].

## Gaps

- WebFetch summarizes pages. Stack quotes in section 5 ([C40]-[C43],
  [C45]-[C47]) were not checked against raw HTML. Every Convex docs claim in
  section 6 was checked against the docs source in convex-backend.
- The function handle docs page (`docs.convex.dev/functions/function-handles`)
  returned 404 to the helper fetch. The claim that a handle stays valid across
  pushes, but the target may no longer exist, comes only from a WebFetch summary
  of `docs.convex.dev/api/modules/server` and is unverified.
- Component tables in export, import and `--replace-all` were confirmed from
  Rust source, not by running an import. I did not check how `--replace-all`
  combined with `--component` limits deletion.
- I did not check whether a transaction-limit error inside a sub-mutation can
  always be caught by the caller. PR #57 says some limits are only reported at
  the outer boundary; that is a third-party claim [C18].
- Behaviour after a restore (rows with dangling `workerId` read as `unknown`,
  and resuming works) is inferred from `lib.ts`, not run.
- The 7-day expiry turning `failed` into `unknown` is inferred from [C14] and
  [C27], not observed.
- The `convex.dev/components/migrations` listing page reportedly claims rollback
  functions and completion estimates that the API does not have. That came from
  a WebFetch summary only and is not used above.
- The scheduler total-argument limit differs between pages: limits.mdx says 16
  MiB, and a WebFetch of the scheduled-functions page reported "8MB". I did not
  open the scheduled-functions source to resolve it.
- No maintainer review exists on PRs #31 or #57 beyond the comments quoted, so
  their merge prospects are unknown.

## Sources

GitHub links are pinned to the SHA in the table at the top unless noted.

- C1. convex/migrations CHANGELOG at main:
  https://github.com/convex/migrations/blob/202fa4afd650f2079123c75b238fb4c2f4ea7d90/CHANGELOG.md
- C2. convex/migrations, compare v0.3.7...main:
  https://github.com/convex/migrations/compare/v0.3.7...202fa4afd650f2079123c75b238fb4c2f4ea7d90
- C3. convex/migrations issue #69 and PR #74 (commit 7d5051e):
  https://github.com/convex/migrations/issues/69 ,
  https://github.com/convex/migrations/commit/7d5051e5cc5d1a556f2bb9fe00dd2a38ac5ae48d
- C4. convex/migrations PR #76 (commit 09cb777):
  https://github.com/convex/migrations/commit/09cb7772cb2087f6bb47fdf364e5bee53cbb895e
- C5. convex/migrations PR #77 (open), docs at head 1dbb9e5:
  https://github.com/convex/migrations/blob/1dbb9e5bd8b9f6a4417cf3dc881cd535b9a6fa3a/docs/team-workflows.mdx
  , .../docs/running-migrations.mdx , .../docs/getting-started.mdx
- C6. convex/migrations PR #78 (open):
  https://github.com/convex/migrations/pull/78
- C7. convex/migrations PR #24 (open), head 5cc50da:
  https://github.com/convex/migrations/pull/24
- C8. convex/migrations PR #72 (closed):
  https://github.com/convex/migrations/pull/72
- C9. convex/migrations issue #28:
  https://github.com/convex/migrations/issues/28
- C10. convex/migrations `src/client/index.ts` at main:
  https://github.com/convex/migrations/blob/202fa4afd650f2079123c75b238fb4c2f4ea7d90/src/client/index.ts
- C11. convex/migrations README at main:
  https://github.com/convex/migrations/blob/202fa4afd650f2079123c75b238fb4c2f4ea7d90/README.md
- C12. convex/migrations issue #16:
  https://github.com/convex/migrations/issues/16
- C13. convex/migrations `src/shared.ts`:
  https://github.com/convex/migrations/blob/202fa4afd650f2079123c75b238fb4c2f4ea7d90/src/shared.ts
- C14. convex/migrations `src/component/lib.ts`:
  https://github.com/convex/migrations/blob/202fa4afd650f2079123c75b238fb4c2f4ea7d90/src/component/lib.ts
- C15. convex/migrations `src/component/schema.ts`:
  https://github.com/convex/migrations/blob/202fa4afd650f2079123c75b238fb4c2f4ea7d90/src/component/schema.ts
- C16. convex/migrations `example/convex/reset.test.ts`:
  https://github.com/convex/migrations/blob/202fa4afd650f2079123c75b238fb4c2f4ea7d90/example/convex/reset.test.ts
- C17. convex/migrations `src/client/log.ts`:
  https://github.com/convex/migrations/blob/202fa4afd650f2079123c75b238fb4c2f4ea7d90/src/client/log.ts
- C18. convex/migrations PR #57 (open, third-party), head 9037945:
  https://github.com/convex/migrations/pull/57
- C19. convex/migrations issue #5: https://github.com/convex/migrations/issues/5
- C20. convex/migrations issue #11:
  https://github.com/convex/migrations/issues/11
- C21. convex/migrations issue #14 (maintainer comment 2025-08-29):
  https://github.com/convex/migrations/issues/14
- C22. convex/migrations issue #30:
  https://github.com/convex/migrations/issues/30
- C23. Convex docs source, `components/using.mdx`:
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/npm-packages/docs/docs/components/using.mdx
- C24. Convex docs source, `components/understanding.mdx`:
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/npm-packages/docs/docs/components/understanding.mdx
- C25. Convex docs source, `cli/reference/run.mdx`:
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/npm-packages/docs/docs/cli/reference/run.mdx
- C26. convex/migrations PR #31 (open), head d442bf6:
  https://github.com/convex/migrations/pull/31
- C27. Convex docs source, `scheduling/scheduled-functions.mdx`:
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/npm-packages/docs/docs/scheduling/scheduled-functions.mdx
- C27a. convex/migrations PR #59 (open) and convex/convex-backend#477
  (maintainer comments 2026-05-28, 2026-07-20):
  https://github.com/convex/migrations/pull/59 ,
  https://github.com/convex/convex-backend/pull/477
- C28. convex/migrations PR #26 (closed):
  https://github.com/convex/migrations/pull/26
- C29. convex/convex-helpers README (migrations 188-200, triggers 1088-1225):
  https://github.com/convex/convex-helpers/blob/964f2d4ec97a19bbc258ddbdbbb522044fec230c/packages/convex-helpers/README.md
- C30. convex/convex-helpers `server/migrations.ts`:
  https://github.com/convex/convex-helpers/blob/964f2d4ec97a19bbc258ddbdbbb522044fec230c/packages/convex-helpers/server/migrations.ts
- C31. convex/workpool README:
  https://github.com/convex/workpool/blob/1360c71d1b6f6f5ce07ca8d6268b6d62a79bacdc/README.md
- C32. convex/workpool `src/client/index.ts`:
  https://github.com/convex/workpool/blob/1360c71d1b6f6f5ce07ca8d6268b6d62a79bacdc/src/client/index.ts
- C33. convex/workflow README:
  https://github.com/convex/workflow/blob/15b2b2dcf12511ec825499fb852e1db0465a620e/README.md
- C34. convex/workflow `src/shared.ts`, `src/client/step.ts`,
  `src/component/journal.ts`:
  https://github.com/convex/workflow/blob/15b2b2dcf12511ec825499fb852e1db0465a620e/src/shared.ts
- C34a. convex/workflow `src/client/workflowMutation.ts`:
  https://github.com/convex/workflow/blob/15b2b2dcf12511ec825499fb852e1db0465a620e/src/client/workflowMutation.ts
- C35. convex/workflow issue #35: https://github.com/convex/workflow/issues/35
- C36. Convex CLI source, `src/cli/lib/run.ts` (`runFunctionAndLog`):
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/npm-packages/convex/src/cli/lib/run.ts
- C37. Convex docs source, `production/state/limits.mdx`:
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/npm-packages/docs/docs/production/state/limits.mdx
- C38. convex/aggregate README:
  https://github.com/convex/aggregate/blob/7583a1e0d2dda716dc51f11955944d47077e583f/README.md
- C39. convex/aggregate `example/convex/leaderboard.ts`:
  https://github.com/convex/aggregate/blob/7583a1e0d2dda716dc51f11955944d47077e583f/example/convex/leaderboard.ts
- C40. Convex Stack, The Secret to Migrations:
  https://stack.convex.dev/the-secret-to-migrations
- C41. Convex Stack, Intro to Migrations:
  https://stack.convex.dev/intro-to-migrations
- C42. Convex Stack, Migrating Data with Mutations:
  https://stack.convex.dev/migrating-data-with-mutations
- C43. Convex Stack, Seeding Data for Preview Deployments:
  https://stack.convex.dev/seeding-data-for-preview-deployments
- C44. GitHub API repo lookups (`gh api repos/get-convex/<repo>` returns
  `convex/<repo>`), checked 2026-11-10.
- C45. Convex Stack, What actually happens when you push to Convex:
  https://stack.convex.dev/what-actually-happens-when-you-push-to-convex
- C46. Convex Stack, Feature gating: https://stack.convex.dev/feature-gating
- C47. Convex Stack, Backend components:
  https://stack.convex.dev/backend-components
- C48. convex/agent-skills skills `convex-migrate`, `convex-migrate-rehearse`,
  `convex-seed`:
  https://github.com/convex/agent-skills/tree/f60629d7c6c1f27eb58a56260546d2445049274d/skills
- C49. convex/agent-skills `convex-migration-helper` at its last version ec1e6ba
  (deleted in 90ae2c3):
  https://github.com/convex/agent-skills/blob/ec1e6baae7d86c7843c22938c75979c016f5c6e9/skills/convex-migration-helper/SKILL.md
  , .../references/migration-patterns.md
- C50. Convex docs source tree:
  https://github.com/convex/convex-backend/tree/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/npm-packages/docs/docs
- C51. Convex docs source, `database/writing-data.mdx`:
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/npm-packages/docs/docs/database/writing-data.mdx
- C52. Convex docs source, `database/schemas.mdx`:
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/npm-packages/docs/docs/database/schemas.mdx
- C53. Convex docs source, `database/reading-data/indexes/indexes.mdx`:
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/npm-packages/docs/docs/database/reading-data/indexes/indexes.mdx
- C54. Convex docs source, `cli/reference/deploy.mdx`:
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/npm-packages/docs/docs/cli/reference/deploy.mdx
- C55. Convex docs source, `cli/reference/dev.mdx`:
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/npm-packages/docs/docs/cli/reference/dev.mdx
- C56. Convex backend, `crates/exports/src/lib.rs`:
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/crates/exports/src/lib.rs
- C57. Convex backend, `crates/application/src/snapshot_import/parse.rs`:
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/crates/application/src/snapshot_import/parse.rs
- C58. Convex backend, `crates/application/src/snapshot_import/mod.rs`:
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/crates/application/src/snapshot_import/mod.rs
- C59. Convex docs source, `cli/reference/import.mdx`:
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/npm-packages/docs/docs/cli/reference/import.mdx
- C60. Convex docs source, `cli/reference/export.mdx`, and CLI
  `src/cli/lib/convexExport.ts`:
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/npm-packages/docs/docs/cli/reference/export.mdx
- C61. Convex docs source, `database/import-export/import.mdx`:
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/npm-packages/docs/docs/database/import-export/import.mdx
- C62. Convex docs source, `database/backup-restore.mdx`:
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/npm-packages/docs/docs/database/backup-restore.mdx
- C63. Convex docs source, `components/overview.mdx`:
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/npm-packages/docs/docs/components/overview.mdx
- C64. Convex docs source, `components/authoring.mdx`:
  https://github.com/convex/convex-backend/blob/b9f41c0eba8ed043bfd96670a62685fc8e1e6b50/npm-packages/docs/docs/components/authoring.mdx
