# Industry survey: data migration systems, and the best design for Convex

Date: 2026-11-10. It answers `docs/research/problem-statement.md`.

This file is the synthesis. The evidence sits in four appendix files under
`docs/research/parts/`, and in the earlier note
`docs/research/baseline-prior-art.md`:

| Prefix | Appendix                    | Covers                                                                                                                                                                         |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C      | `parts/convex.md`           | `@convex-dev/migrations`, convex-helpers migrations, workpool, workflow, aggregate, triggers, Stack posts, agent skills, platform limits, import and export source             |
| S      | `parts/sql-orm.md`          | Rails, `maintenance_tasks`, `data_migrate`, Django, Prisma 7 and 8, Flyway, Liquibase, Ecto, Laravel, Atlas, sqitch, golang-migrate                                            |
| O      | `parts/online.md`           | GitLab batched background migrations, `maintenance_tasks` and job-iteration operations, gh-ost, pt-osc, Stripe, Scientist, Vitess, PlanetScale, expand/contract, Notion, Figma |
| N      | `parts/nosql-localfirst.md` | MongoDB versioning pattern, Mongock, migrate-mongo, Prisma for MongoDB, Firestore and fireway, DynamoDB, Realm, Couchbase, Replicache, Zero, Electric, Convex and old clients  |
| P      | `baseline-prior-art.md`     | First pass: baseline versus replay, readiness flags, derived-data rebuild                                                                                                      |

A citation such as `[C14]` means source 14 in the Sources list of
`parts/convex.md`. The combined source list is at the end of this file. Every
source was read at a pinned tag or commit where one exists. Pins are listed in
each appendix.

## Citation spot-check

The appendices were drafted first. Before merging, I re-fetched 16 high-impact
claims from their pinned sources on 2026-11-10. All 16 match.

| Claim                                                                                                                   | Source re-read                                                          | Result                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `migrate` catches a failing batch and stores `error` [C14]                                                              | `src/component/lib.ts` 113-196 at `202fa4a`                             | matches                                                                                       |
| The runner returns `Migration failed: ...` instead of throwing [C17]                                                    | `src/client/log.ts` 25-26; `_runInteractive` rethrows only outer errors | matches                                                                                       |
| `runToCompletion` throws `status.error` [C10]                                                                           | `src/client/index.ts` 820-832                                           | matches                                                                                       |
| `convex run` exits 1 only through `ctx.crash` on a thrown call [C36]                                                    | CLI `run.ts` at `b9f41c0`                                               | matches                                                                                       |
| Limits: 1 s user code, 32,000 scanned, 4,096 index ranges, 16,000 written, 16 MiB each way, 30 and 10 min actions [C37] | `limits.mdx` 155-185                                                    | matches                                                                                       |
| Export writes component tables under a component path prefix [C56]                                                      | `crates/exports/src/lib.rs` 355-376, 476-487                            | matches                                                                                       |
| Workflow journal cap is `8 << 20` [C34]                                                                                 | `src/shared.ts` line 1 at `15b2b2d`                                     | matches                                                                                       |
| Rails `assume_migrated_upto_version` inserts every older local version [S4]                                             | `schema_statements.rb` 1397-1416 at v8.1.4.1                            | matches                                                                                       |
| Django `check_replacements` runs on every migrate [S17]                                                                 | `executor.py` 294-308 at 6.0.10                                         | matches                                                                                       |
| Prisma 8 `dataTransform` takes `check` and `run`; compiled pre- and postcheck; retry needs a restore [S35]              | live docs page                                                          | matches. The page says "Prisma ORM 8" but not "release candidate"; that label rests on [S39]. |
| GitLab marks a migration `:finish` at enqueue when the table is empty [O2]                                              | helper lines 329, 346 at `v19.2.10-ee`                                  | matches                                                                                       |
| GitLab: "You cannot depend on any batched background migration being completed until after it is finalized" [O1]        | doc line 373                                                            | matches                                                                                       |
| Mongock `runAlways` runs every time but is tracked once [N13]                                                           | `ChangeExecutorBase.java` 220-278                                       | matches                                                                                       |
| fireway uses a high-water mark and throws on a failed latest row [N29]                                                  | `src/index.js` 300-385                                                  | matches                                                                                       |
| Replicache IDB name includes `schemaVersion` [N44]                                                                      | `make-idb-name.ts` 10-21                                                | matches                                                                                       |
| Zero deploy order: expand DB, API, client; contract client, API, DB; new column hidden until backfilled [N48]           | live docs page                                                          | matches                                                                                       |

The appendices' own Gaps sections still apply. Stack posts and several vendor
blogs were read through a summarizing fetch tool, not raw HTML.

## Short answer

The best design for Convex combines five ideas. Each one comes from a system
that already ships it.

1. Record a migration as done without running it, behind a data-level guard.
   Every SQL tool can do this [S4][S15][S16][S29][S37][S61][S88]. GitLab does it
   automatically: a background migration enqueued on an empty table is recorded
   finished [O2]. `@convex-dev/migrations` cannot do it at all [C14].
2. Attach a needs-work check to each migration. Prisma 8 compiles each data
   transform into a precheck, the update and a postcheck, and skips the step
   when the postcheck already passes [S34][S35]. One check serves as the skip
   test, the verifier, the baseline guard and the test assertion.
3. One command that runs the whole series, waits, and fails loudly. Rails,
   Django, Flyway, Liquibase and Atlas all run in the foreground and exit
   non-zero on failure [S3][S16][S48][S64][S82]. Upstream Convex returns after
   one batch and exits 0 on failure [C17][C36].
4. Separate run-once migrations from re-runnable derived-data rebuilds. Flyway
   repeatable migrations and Liquibase `runOnChange` re-run when their content
   changes [S52][S62]. Mongock `runAlways` runs every time [N13]. Local-first
   systems throw derived state away and rebuild it when its version changes
   [N44][N51].
5. Readers ask the migration state, not an app flag. GitLab forbids depending on
   a migration before it is finalized [O1]. DynamoDB and Zero hide a new index
   or column until its backfill ends [N35][N48]. With idea 1, a fresh deployment
   reads "done" for every migration, so it needs no flag-flipping migration.

Around these five: an append-only event log [S94][N14], a single lease so a
second caller attaches instead of racing [N7][N16], sticky failure with explicit
retry, mark-applied and reset [S29][S53][S95], pruning that is safe because of
the baseline [S3][S16][O12], and convex-test helpers that run a migration to
completion in-process [O5][S85].

The rest of this file gives the evidence by axis, a comparison table, the
judgment in detail, and what to reject.

## Convex constraints that shape the design

These facts come from Convex docs source, CLI source and backend source at
`b9f41c0`, unless noted.

- Each query or mutation may scan 32,000 documents, read 4,096 index ranges,
  write 16,000 documents, and read and write 16 MiB each. User code gets 1 s,
  excluding database time [C37]. The problem statement's "about 4,096 reads or
  writes" is only the index-range limit [C37].
  `ctx.meta.getTransactionMetrics()` reports usage against each limit at runtime
  [C51].
- Actions run up to 30 minutes on the Convex runtime and 10 minutes on Node
  [C37]. Scheduled mutations run exactly once; actions at most once [C27].
- The first push after a schema change validates every existing document and
  fails on any mismatch [C52]. Staged validators can run that scan in the
  background before promotion [C52]. Pushes are atomic and wait for index
  backfill and validation [C45].
- `convex run` makes one call, prints the result and exits 1 only when the call
  throws. It does not follow scheduled work, and `--watch` works only for
  queries [C25][C36].
- A component cannot read app tables or call app functions unless the app passes
  a function handle [C24][C63][C64]. Each component call is a sub-transaction
  that the caller can catch [C23][C24].
- Snapshot export includes component tables, and ZIP import restores them.
  `--replace-all` clears or deletes every non-system table in every namespace
  [C56][C57][C58][C59]. A full snapshot import therefore brings the source's
  migration status with it. This supersedes the open question in [P34].
- `convex import` writes documents directly. Triggers do not run [C29]. Backups
  exclude pending scheduled functions [C62].
- Old browser tabs keep calling the backend after a deploy. Convex docs require
  backwards-compatible functions for that reason, and scheduled functions run
  new code with old arguments [N52]. The client sends only its library version,
  not an app version [N53].
- Convex maintainers prefer composing behavior in libraries, and do not want
  deploys blocked on unbounded data work [C21].

## Findings by axis

### 1. Fresh-deployment baseline

- Rails `db:schema:load` marks every local migration older than the dumped
  version as run [S4][S5]. `data_migrate` copies the same mechanism for data
  migrations [S15].
- Django squashes migrations and records all replaced migrations when the squash
  is applied. `check_replacements` handles a squash pushed to a deployment that
  already ran the originals [S17]. `--fake` marks as applied without running and
  needs manual care [S16][S21].
- Prisma 7 `migrate resolve --applied` records a migration without running it
  [S29]. Prisma 8 `db sign` checks the tables against the contract before
  writing the marker [S37].
- Flyway has baseline migrations for new environments and `baselineOnMigrate`
  for existing ones [S1]. Liquibase `changelog-sync` marks all undeployed
  changes executed; its docs name baselining as the main use [S61].
- Atlas refuses a non-clean database with no revisions unless `--baseline` or
  `--allow-dirty` is set [S82][S88]. Checkpoints let a clean database skip older
  files [S83].
- GitLab records a background migration as finished at enqueue time when the
  table is empty and no explicit bound is set [O2]. This is the only data-level
  automatic baseline found.
- Mongock imports another tool's history and throws if the imported count
  differs from an expected number [N9].
- Upstream Convex has no baseline and no mark-done API. No upstream issue or PR
  asks for one; the searches are recorded in `parts/convex.md` section 1.2
  [C14].

Judgment: an explicit, guarded baseline is universal outside Convex. The guard
matters. Atlas and Prisma 8 check the database before they write the record
[S37][S88]. GitLab checks emptiness per migration [O2]. Convex has no schema
dump, so the guard must be a data query.

### 2. Waiting and series semantics

- SQL CLIs run in the foreground and exit non-zero on failure. Flyway documents
  exit code 1 [S48]. Django `migrate --check` and Prisma `migrate status` exit 1
  on pending or failed work [S16][S25].
- Three tools return success when they did not succeed.
  `maintenance_tasks perform` only enqueues [S9]. Laravel `--isolated` exits 0
  when another run holds the lock, and `--graceful` exits 0 on error [S66][S77].
- GitLab finalize runs the remaining batches inline or raises with the exact
  command to finish [O2][O5]. `execute_all` runs every unfinished migration in
  order and continues past failures [O10].
- Upstream Convex: the runner returns after the first batch and chains the rest
  with `runAfter(0)` [C14]. A failure returns a log object, so `convex run`
  exits 0 [C17][C36]. Only `runToCompletion`, for a single migration inside an
  action, throws [C10]. Open PR #24 would add an inline action runner [C7].
- Workflow could host a series, but a growing step list trips its determinism
  check, and a step per batch fills its 8 MiB journal [C33][C34].

Judgment: the caller needs one command that waits for the whole series and
throws on failure. In Convex that command must be an action, bounded by 30
minutes [C37]. Work itself should stay in scheduled mutations so it survives the
caller disconnecting.

### 3. Failure and resume

- Failure is sticky in mature tools. golang-migrate sets a dirty flag and
  refuses everything until `force` [S95]. Flyway keeps a failed row until
  `repair` [S41][S53]. Prisma blocks `deploy` until `resolve` [S29]. fireway
  refuses to run after a failed row [N29].
- Atlas records how many statements of a file ran and resumes from the failed
  one [S82][S88]. Mongock resumes from the failed unit [N5].
- GitLab retries a job three times, halves and splits a batch on timeout, and
  fails the migration when more than half of the jobs fail after 50 jobs
  [O3][O4].
- job-iteration can repeat an item after a crash because the cursor is saved
  separately from the work [O19][O22]. Vitess persists copy state in the same
  transaction as the copy [O41].
- Upstream Convex main catches a failing batch inside a sub-transaction and
  stores `error`, including on the first batch [C14][C16]. Aborts of the outer
  transaction (OCC exhaustion, the 1 s limit, limits counted at the outer
  boundary) are not recorded. They show only on the worker's
  `_scheduled_functions` row for 7 days [C18][C27]. Issue #5 stays open for that
  reason [C19].

Judgment: Convex has the transactional property Vitess has. The batch writes and
the cursor commit together, so state after a failure is exact. The component
should record batch failures through a sub-transaction, detect outer aborts from
its own scheduled-function rows, keep the migration failed until an operator
acts, and halve the batch on limit errors. PR #57 shows adaptive sizing with
`getTransactionMetrics()` [C18].

### 4. Verification

- Prisma 8 runs a postcheck after every operation and skips the operation when
  the postcheck already passes [S34][S35].
- sqitch runs a verify script per change and reverts on failure [S89][S91].
  Liquibase `sqlCheck` preconditions can mark a changeset ran [S64].
- Checksums of migration files guard against edits: Flyway CRC32, Liquibase MD5,
  Prisma, sqitch SHA1, Atlas's cumulative `atlas.sum` [S40][S65][S24][S92][S81].
  migrate-mongo uses its hash to re-run changed files instead [N21][N23].
  fireway stores a checksum and never compares it [N29].
- Online tools verify data: pt-table-checksum per chunk [O35], Vitess VDiff with
  resume [O44], Stripe's re-scan plus Scientist read comparison [O36][O37],
  Notion's sampled verifier written by a second engineer [O52]. GitLab states
  verification only as a best practice [O1].
- Convex staged validators verify a stricter schema against all documents in the
  background [C52]. The Convex agent skill recommends a `verifyMigration` query
  that samples unmigrated documents [C49].

Judgment: verify the data, not the code. A per-migration check query that
returns documents still needing work is cheap in Convex and carries over to the
other axes. Convex function source is not visible at runtime, so a source
checksum would need a build step (inference), and the strongest tools verify
data anyway [O35][O44].

### 5. Readiness gating for expand and contract

- GitLab: code may not depend on a migration until finalize, and a RuboCop cop
  checks declared dependencies [O1].
- gh-ost, Vitess and PlanetScale separate "data copied" from "cut over" with a
  postpone flag, `ready_to_complete` or a gated deploy [O28][O38][O46].
- DynamoDB keeps a new index `CREATING` until backfill ends [N35]. Zero hides a
  new column until it is backfilled [N48].
- Zero publishes the deploy order: expand DB, API, client; contract client, API,
  DB [N48]. Realm says remove a field from clients first and leave it on the
  server [N39].
- Convex's own guidance has no flags tied to migrations. The feature-gating post
  stores flags in an app table where a missing row reads `undefined` [C46].
  Staged validators and staged indexes are the platform's built-in gates
  [C52][C53].
- The motivating app's app-table flags make readers degrade on a fresh
  deployment, which needs a migration just to set them (problem 3) [O57].

Judgment: readiness should be a query on the component's state, true when a
migration is done or covered by the baseline. A fresh deployment then reads
ready everywhere. The contract step stays a separate, explicit act, because
Convex cannot see old clients [N53].

### 6. Derived-data rebuild

- Flyway `R__` migrations re-run whenever their checksum changes, always after
  versioned migrations [S52]. Liquibase has `runOnChange` and `runAlways` [S62].
  Mongock `runAlways` runs every time and is recorded once [N13].
- Replicache opens a new local database when `schemaVersion` changes [N44].
  Electric invalidates shapes when columns change [N51]. Neither replays
  history.
- Firestore imports skip Cloud Functions [N28]. Convex imports skip triggers
  [C29].
- Aggregate's own guidance: switch to idempotent writes, backfill with a
  migration, switch back. Repair means clear and backfill again [C38].
- Upstream tracks a rebuild like any migration, keyed by function name, and
  imports its status with the snapshot. After a full import the rebuild reads
  done and is skipped [C10][C14][C56].

Judgment: a rebuild is a different kind from a migration. It is keyed by an
author-declared version, re-runs when the version changes, and can be forced
after an import. Imported status must not be able to suppress a forced rebuild.

### 7. Pruning and squash

- Rails shows rows without a file as `NO FILE`, Ecto `FILE NOT FOUND`, Flyway
  `Missing` [S3][S72][S54]. Django `migrate --prune` deletes stale rows and
  refuses while a squash still `replaces` them [S16].
- GitLab deletes job code after the next required stop following finalize, and
  automates squash at each required stop [O1][O12]. A bot opens finalize MRs for
  overdue migrations [O13].
- `maintenance_tasks` says to delete task code once it is no longer needed [S8].
- migrate-mongo silently ignores history rows whose file is gone [N21].
- Upstream Convex documents no pruning [P15][P16]; the motivating app invented
  an archive workflow [O57].

Judgment: pruning is safe once every deployment either ran a migration or was
created after it. A baseline that lists the pruned names makes that checkable.

### 8. Observability

- Rich history rows: Flyway records checksum, success, duration and installer
  [S51]. Liquibase records exec type including `MARK_RAN` and a deployment ID
  [S58]. Atlas records applied and total statements and the failed statement
  [S88]. `maintenance_tasks` records ticks, arguments, metadata and backtrace
  [S11].
- Append-only logs: sqitch `events` [S94], Mongock entries with derived current
  state [N14][N15], GitLab job transition logs with exception text [O4].
- Upstream Convex stores one mutable row per migration. `next` and `batchSize`
  exist only on the pending worker's arguments, so a finished series forgets its
  list [C14].

Judgment: keep a current-state row per migration plus an append-only event log
that records how each state was reached: ran, baselined, marked applied, reset,
rebuilt.

### 9. Testability

- GitLab provides `run_entire_migration` for tests and matchers for scheduled
  migrations [O5][O7]. Atlas `migrate test` migrates to a version, seeds,
  migrates on, and asserts [S85]. `maintenance_tasks` tests `process` directly
  [S8]. Mongock's test base resets history between tests [N11].
- Upstream Convex ships a `/test` entrypoint for convex-test registration only
  [C1].

Judgment: export a convex-test helper that runs one migration or the whole
series to completion in-process, and one that runs a migration's check as an
assertion.

## Comparison table

"none" means the system has no mechanism. "n/a" means the axis does not apply.
Cells are short; the appendices hold detail.

| System                        | Fresh baseline                                       | Wait / exit code                                     | Failure, resume                             | Verification                             | Readiness gate                       | Derived rebuild                                         | Pruning                                  | History                                |
| ----------------------------- | ---------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------- | ---------------------------------------- | ------------------------------------ | ------------------------------------------------------- | ---------------------------------------- | -------------------------------------- |
| `@convex-dev/migrations` main | none [C14]                                           | returns after 1 batch, exits 0 on failure [C17][C36] | sub-txn catch; outer aborts lost [C14][C18] | dry run, primary table only [C10]        | none                                 | tracked as a migration, skipped after import [C14][C56] | undocumented [P15][P16]                  | 1 mutable row [C15]                    |
| convex-helpers migrations     | none                                                 | same chain [C30]                                     | failure rolls back the record [C30]         | none                                     | none                                 | none                                                    | none                                     | app table [C30]                        |
| Rails + `data_migrate`        | schema load marks older run [S4][S15]                | foreground [S3]                                      | per-migration txn [S3]                      | none                                     | pending error [S14]                  | none                                                    | `NO FILE` [S3]                           | version only [S6]                      |
| `maintenance_tasks`           | n/a [S8]                                             | enqueue only [S9]                                    | cursor resume, pause, cancel [S8]           | none                                     | none [S8]                            | n/a                                                     | delete code [S8]                         | rich run row [S11]                     |
| Django                        | squash, `--fake` [S16][S17]                          | `--check` exits 1 [S16]                              | per-migration txn, no lock [S16]            | none                                     | none                                 | none                                                    | `--prune` [S16]                          | app, name, applied [S18]               |
| Prisma 7 / 8                  | `resolve --applied`; `db sign` with check [S29][S37] | `status` exits 1 [S25]                               | blocks until resolve [S29]                  | pre/postcheck per op (8) [S34]           | none                                 | none                                                    | squash [P7]                              | checksum, logs; marker [S33][S38]      |
| Flyway                        | `B` migrations [S1]                                  | exit 1 [S48]                                         | failed row, `repair` [S41]                  | CRC32 validate [S40]                     | none                                 | `R__` on checksum change [S52]                          | Missing state [S54]                      | rank, checksum, time [S51]             |
| Liquibase                     | `changelog-sync` [S61]                               | non-zero [S64]                                       | lock table [S59]                            | MD5, preconditions [S64][S65]            | contexts [S62]                       | `runOnChange` [S62]                                     | none found                               | exectype, deployment id [S58]          |
| Atlas                         | `--baseline`, checkpoint [S83][S88]                  | stops [S82]                                          | statement-level resume [S82]                | `atlas.sum`, lint, test [S81][S84][S85]  | none                                 | none                                                    | checkpoint [S83]                         | applied/total, error stmt [S88]        |
| GitLab BBM                    | empty table finishes at enqueue [O2]                 | finalize inline or raise [O2][O5]                    | 3 tries, split, ratio fail [O3][O4]         | best practice only [O1]                  | finalize, declared deps [O1]         | none                                                    | delete after stop, auto squash [O1][O12] | transition logs [O4]                   |
| Vitess / PlanetScale          | n/a                                                  | `ready_to_complete`, gated deploy [O38][O46]         | resume after failover, `RETRY` [O39][O41]   | VDiff [O44]                              | postpone completion [O38]            | n/a                                                     | `CLEANUP` [O39]                          | `show vitess_migrations` [O39]         |
| Mongock                       | legacy import with count check [N9]                  | blocks app start [N5]                                | resume from failed unit [N5]                | count check [N9]                         | version window [N6]                  | `runAlways` [N13]                                       | none                                     | append-only states [N14]               |
| migrate-mongo / fireway       | none                                                 | stops at first failure [N20][N29]                    | fireway fails closed [N29]                  | hash re-runs; unused checksum [N21][N29] | none                                 | hash re-run [N23]                                       | rows ignored [N21]                       | changelog / high-water mark [N20][N29] |
| DynamoDB                      | none                                                 | Step Functions map [N31]                             | redrive reprocesses [N31]                   | violation detector [N35]                 | GSI `CREATING` [N35]                 | scan plus streams [N33]                                 | none                                     | counts [N36]                           |
| Replicache / Zero / Electric  | new local DB per version [N44]                       | n/a                                                  | client reset, re-sync [N47][N50][N51]       | structural check (Zero) [N49]            | column hidden until backfilled [N48] | discard and re-sync [N44][N51]                          | n/a                                      | n/a                                    |

## Judgment: the best design for Convex

Ranked by how much each part fixes the six problems in the problem statement
under Convex's constraints. Items marked "inference" go beyond what a source
shows and need a test on a real deployment.

1. **Guarded baseline with a retired-names list.** Fixes problems 1, 3 and 6.
   - A migration is skipped and recorded `baselined` when its check finds no
     work, or when its table has no documents and it has no check. That is
     GitLab's empty-at-enqueue rule [O2] combined with Prisma 8's
     skip-on-postcheck [S34].
   - Code may delete a finished migration and add its name to a `retired` list.
     On a deployment whose history has no entries and whose guard passes, the
     component records every retired name as `baselined`. On a deployment with
     history, it verifies that every retired name is done, and fails loudly if
     one is not. Django's `replaces` and GitLab's required stops show the two
     halves of this [S17][O1][O11].
   - If history is empty but the guard fails (an app adopting the component on
     existing data, or an import of app tables only), the component refuses and
     asks for an explicit `markApplied`. That is Atlas's refusal without
     `--baseline` [S88].
   - The default guard checks that the tables of registered migrations are
     empty. The app can pass its own guard query. Inference: the right default
     guard for apps with seeded reference data is untested.

2. **Per-migration check query.** Used as skip test, postcheck before `done`,
   baseline guard and test assertion [S34][S35][S74][C49]. A migration may omit
   it; then emptiness is the only automatic skip and there is no postcheck. If
   the postcheck still finds work after a full pass (for example old clients
   writing the old shape [N52]), the migration ends `needsAttention` with a
   count and sample IDs instead of `done`. Inference: whether to re-pass
   automatically or stop is a design choice; Prisma stops [S34].

3. **One wait-and-fail command.** Fixes problem 2.
   - `runAll` is an internal action. It starts or attaches to the active run,
     then waits until every migration in the series is done, baselined or
     failed. It throws on failure, so `convex run` exits 1 [C36].
   - Batches run as scheduled mutations, so work continues if the caller
     disconnects. The action only waits. Inference: polling status from an
     action with `setTimeout` is assumed to work; not yet tested.
   - Near the action time limit it throws a "still running, call again to keep
     waiting" error. A second call attaches to the same run [N7][N16]. This
     keeps the 30-minute limit [C37] from silently cutting off the wait.

4. **Sticky failure with explicit resolution.** The migration stays `failed`
   with error text, batch number and cursor. Later migrations in the series
   wait. Operators get `retry` (resume from the cursor after a code fix),
   `markApplied` and `reset` [S29][S41][S95]. The component records batch
   failures through a sub-transaction catch [C14] and outer aborts by reading
   its own `_scheduled_functions` rows [C14][C27]. On a limit error it halves
   the batch and retries, like GitLab's split [O4] and PR #57 [C18].

5. **Readiness query.** `isReady(name)` returns true when the migration is done
   or baselined. Readers use it instead of app flags. Fixes problem 3 together
   with item 1. Basis: GitLab finalize [O1], DynamoDB and Zero backfill gates
   [N35][N48].

6. **Rebuilds as a separate kind.** A rebuild has a name, an author-declared
   `version` and an app handle. It re-runs when the declared version differs
   from the recorded one, or when an operator calls `rebuild` (for example after
   `convex import`). Rebuilds run after migrations, as Flyway orders repeatables
   [S52]. Fixes problem 4. Inference: automatic detection of an import is not
   designed here and may not be possible; the explicit command is the reliable
   path.

7. **Seeds stay out of migration history.** Rails, `maintenance_tasks`, Laravel
   and Prisma keep seeds separate [P1][S8][S67][S32]. The component may offer an
   `always` step list for idempotent app functions that `runAll` calls on every
   run, like Mongock `runAlways` [N13]. That gives one function shared by the
   deploy step and the dev seed script. Fixes problem 5. Whether the component
   should own this at all is a scope question. ADR 1 answers it: the component
   owns Seeds.

8. **Append-only event log plus current state.** Every transition is an event
   with its cause [S58][S94][N14]. Status lists orphaned history rows, names
   that are recorded but no longer registered, the way Rails shows `NO FILE`
   [S3].

9. **Stable IDs, not function paths.** Upstream keys state by function name, so
   moving a file re-runs the migration [C14]. Liquibase and Mongock use an
   explicit ID [S63][N4]. Each migration should declare an ID string.

10. **Single lease.** The active run holds a lease row with an expiry. Convex
    mutations are serializable, so one mutation can test and take it [N55]. An
    expiry avoids Liquibase's stale-lock problem [S59].

11. **convex-test helpers.** Run one migration or the series to completion
    in-process, and assert a check returns nothing [O5][S85].

12. **Lower priority.** Typed runtime arguments (upstream issue #30) [C22][S8].
    Adaptive batch sizing from `getTransactionMetrics()` [C18][C51][O6]. Pause
    and throttle between batches [S8][O27]. A deploy-order guide for expand and
    contract, following Zero [N48]. Importing status from
    `@convex-dev/migrations`, following Mongock's count-checked legacy import
    [N9]; a component cannot read another component's tables, so an app-side
    helper would pass the names [C24].

### How the ADRs narrowed this judgment

The ADRs adopt items 2 to 11 with two changes. ADR 2 drops the automatic skip in
item 1: a Migration on an empty table is run, which costs one empty Batch,
instead of being recorded as skipped. That keeps a single path to Done and
avoids inferring Done from data. ADR 7 defers the retired-names list; schema
validation on push is the backstop for stale deployments. ADR 2 and ADR 7 record
these choices.

## What to reject

- Blocking `convex deploy` on data work. Convex maintainers reject it [C21], and
  pushes already block on index backfill and validation [C45].
- Running the series as one Workflow. The determinism check fails when the list
  changes, and the journal caps at 8 MiB [C33][C34].
- Source checksums. TypeScript source is not visible at runtime. Verifying data
  covers the same risk better [S40][O44].
- A high-water mark. fireway skips any migration below the latest applied
  version, so two branches can lose one [N29]. Use set semantics by ID
  [N13][N21].
- Automatic baseline on empty history alone. An app adopting the component on
  existing data also has empty history. The guard must look at data [S88][O2].
- Fail-fast or short-timeout locks. A duplicate deploy step should attach and
  wait, not fail or report false success [S3][S66].
- Rollback functions. Mongock requires them [N4], but forward-only with
  expand/contract is Convex's own guidance [C40][N52], and Vitess-style reverts
  do not apply to data transforms [O40].

## Gaps

- No component code exists yet. Every item marked "inference" above is
  unverified on a deployment, in particular: polling from an action, reading the
  component's own `_scheduled_functions` rows to detect outer aborts, and the
  default baseline guard.
- Whether a transaction-limit error inside a sub-mutation can always be caught
  by the caller is unverified. PR #57 says some are reported only at the outer
  boundary [C18].
- Behavior of `--replace-all` combined with `--component` was not checked [C59].
- No source shows a reliable way for a function to detect that a `convex import`
  happened. The rebuild design therefore relies on an explicit command.
- The 7-day expiry of scheduled-function results turning `failed` into `unknown`
  upstream is inferred from source, not observed [C14][C27].
- Prisma 8 is a release candidate per its docs index [S39]; its migration model
  may change.
- Vendor blogs (Stripe, PlanetScale, Notion, Figma, AWS) and Convex Stack posts
  were read through a summarizing fetch tool. See the Gaps sections of
  `parts/online.md` and `parts/convex.md`.
- Couchbase old-client behavior and Flamingock were not researched. See the Gaps
  section of `parts/nosql-localfirst.md`.
- Each appendix lists its own remaining gaps.

## Sources

Each group is copied verbatim from the appendix named in its heading. Pinned
commits for each group are listed at the top of its Sources section in the
appendix.

### C: Convex ecosystem (`parts/convex.md`)

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

### S: SQL and ORM systems (`parts/sql-orm.md`)

Pinned commits: maintenance_tasks v2.17.0 `6d6e4c0`, data-migrate 11.4.0
`c66da4f`, rails v8.1.4.1 `3f290b7`, django 6.0.10 `3183692`, flyway-13.12.1
`1559183`, liquibase v5.0.4 `2c25134`, ecto_sql v3.14.0 `670f689`,
laravel/framework v13.40.0 `1449bf2`, laravel/docs 13.x `f3c3ee8`, atlas v1.3.0
`9a6bc60`, sqitch v1.6.1 `ce0550c`, golang-migrate v4.20.1 `504568a`,
prisma-engines main `d1b3f37`.

- S1. Prior note in this repo: `docs/research/baseline-prior-art.md` (Rails
  guide, Django docs, Prisma baselining and squashing, Flyway baseline, Laravel
  squashing, Ecto load, GitLab sections)
- S2. Rails Guides, Active Record Migrations:
  https://guides.rubyonrails.org/active_record_migrations.html
- S3. rails `activerecord/lib/active_record/migration.rb` lines 186-193
  (`ConcurrentMigrationError`), 1330-1347 (`NO FILE`), 1539-1551 (per-migration
  transaction and error), 1600-1630 (advisory lock):
  https://github.com/rails/rails/blob/v8.1.4.1/activerecord/lib/active_record/migration.rb
- S4. rails `connection_adapters/abstract/schema_statements.rb` lines 1397-1416
  (`assume_migrated_upto_version`):
  https://github.com/rails/rails/blob/v8.1.4.1/activerecord/lib/active_record/connection_adapters/abstract/schema_statements.rb#L1397-L1416
- S5. rails `activerecord/lib/active_record/schema.rb` line 60:
  https://github.com/rails/rails/blob/v8.1.4.1/activerecord/lib/active_record/schema.rb#L60
- S6. rails `activerecord/lib/active_record/schema_migration.rb` lines 53-61:
  https://github.com/rails/rails/blob/v8.1.4.1/activerecord/lib/active_record/schema_migration.rb#L53-L61
- S7. rails `connection_adapters/postgresql_adapter.rb` lines 474-478
  (`pg_try_advisory_lock`):
  https://github.com/rails/rails/blob/v8.1.4.1/activerecord/lib/active_record/connection_adapters/postgresql_adapter.rb#L474-L478
- S8. Shopify/maintenance_tasks README (lines 25-62 scope, 112-193 task API,
  195-410 CSV, batches, no-collection, enumerators, 416-469 throttling, 470-519
  parameters, 549-649 cursor columns and notifications, 650-732 callbacks and
  considerations, 734-852 testing, 853-937 running and statuses, 974-1025
  interruption and stuck tasks, 1031-1116 errors, 1267-1366 config):
  https://github.com/Shopify/maintenance_tasks/blob/v2.17.0/README.md
- S9. maintenance_tasks `lib/maintenance_tasks/cli.rb` lines 8-48:
  https://github.com/Shopify/maintenance_tasks/blob/v2.17.0/lib/maintenance_tasks/cli.rb
- S10. maintenance_tasks `app/models/concerns/maintenance_tasks/run_concern.rb`
  lines 11-38 (statuses), 75-110 (stale-object retry), 154-167
  (`persist_error`):
  https://github.com/Shopify/maintenance_tasks/blob/v2.17.0/app/models/concerns/maintenance_tasks/run_concern.rb
- S11. maintenance_tasks `db/migrate/` (create runs table, arguments,
  lock_version, metadata, cursor_is_json):
  https://github.com/Shopify/maintenance_tasks/tree/v2.17.0/db/migrate
- S12. maintenance_tasks `app/models/maintenance_tasks/task_data_index.rb` lines
  28-52:
  https://github.com/Shopify/maintenance_tasks/blob/v2.17.0/app/models/maintenance_tasks/task_data_index.rb#L28-L52
- S13. maintenance_tasks `app/models/maintenance_tasks/runner.rb` lines 22-56:
  https://github.com/Shopify/maintenance_tasks/blob/v2.17.0/app/models/maintenance_tasks/runner.rb
- S14. ilyakatz/data-migrate README lines 9-35, 73-107, 133-146:
  https://github.com/ilyakatz/data-migrate/blob/11.4.0/README.md
- S15. data-migrate `lib/data_migrate/data_schema.rb` lines 11-53:
  https://github.com/ilyakatz/data-migrate/blob/11.4.0/lib/data_migrate/data_schema.rb
- S16. django `django/core/management/commands/migrate.py` lines 51-90
  (options), 189-238 (`--prune`), 255-262 (`--check`):
  https://github.com/django/django/blob/6.0.10/django/core/management/commands/migrate.py
- S17. django `django/db/migrations/executor.py` lines 241-277 (apply and record
  replaced), 294-308 (`check_replacements`):
  https://github.com/django/django/blob/6.0.10/django/db/migrations/executor.py
- S18. django `django/db/migrations/recorder.py` lines 32-40:
  https://github.com/django/django/blob/6.0.10/django/db/migrations/recorder.py
- S19. django `django/db/migrations/operations/special.py` lines 149-213
  (`RunPython`):
  https://github.com/django/django/blob/6.0.10/django/db/migrations/operations/special.py
- S20. django `docs/topics/migrations.txt` lines 175-193, 442-460, 611-618,
  732-745:
  https://github.com/django/django/blob/6.0.10/docs/topics/migrations.txt
- S21. django `docs/ref/django-admin.txt` lines 794-802, 832-841, 1152-1164:
  https://github.com/django/django/blob/6.0.10/docs/ref/django-admin.txt
- S22. django `docs/howto/writing-migrations.txt` lines 185-225:
  https://github.com/django/django/blob/6.0.10/docs/howto/writing-migrations.txt
- S23. django `docs/ref/settings.txt` lines 806-812 (`MIGRATE`):
  https://github.com/django/django/blob/6.0.10/docs/ref/settings.txt
- S24. Prisma ORM 7, Development and production (deploy, advisory locking):
  https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/development-and-production
- S25. Prisma ORM 7 CLI, `migrate status` exit codes:
  https://www.prisma.io/docs/cli/v7/migrate/status
- S26. Prisma ORM 7 CLI, `migrate deploy`:
  https://www.prisma.io/docs/cli/v7/migrate/deploy
- S27. Prisma ORM 7, About the shadow database:
  https://www.prisma.io/docs/orm/v7/prisma-migrate/understanding-prisma-migrate/shadow-database
- S28. Prisma ORM 7, Migration histories:
  https://www.prisma.io/docs/orm/v7/prisma-migrate/understanding-prisma-migrate/migration-histories
- S29. Prisma ORM 7, Patching and hotfixing:
  https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/patching-and-hotfixing
- S30. Prisma ORM 7 CLI, `migrate diff`:
  https://www.prisma.io/docs/cli/v7/migrate/diff
- S31. Prisma ORM 7 guide, Expand-and-contract migrations:
  https://www.prisma.io/docs/guides/v7/database/data-migration
- S32. Prisma ORM 7, Seeding:
  https://www.prisma.io/docs/orm/v7/prisma-migrate/workflows/seeding
- S33. prisma-engines
  `schema-engine/connectors/sql-schema-connector/src/flavour/postgres.rs` lines
  364-382 (advisory lock), 524-533 (`_prisma_migrations`):
  https://github.com/prisma/prisma-engines/blob/d1b3f377ca835d73fd50954a5e22128b9ebdd6b8/schema-engine/connectors/sql-schema-connector/src/flavour/postgres.rs
- S34. Prisma ORM 8, How migrations work ("Every operation checks itself"):
  https://www.prisma.io/docs/orm/migrations/how-migrations-work
- S35. Prisma ORM 8, Editing a migration (`dataTransform`):
  https://www.prisma.io/docs/orm/migrations/editing-a-migration
- S36. Prisma ORM 8, The migration graph (Baselines):
  https://www.prisma.io/docs/orm/migrations/the-migration-graph
- S37. Prisma ORM 8, Generating a migration (`db sign`, automatic baseline):
  https://www.prisma.io/docs/orm/migrations/generating-a-migration
- S38. Prisma ORM 8, Applying a migration (marker, failure, concurrency):
  https://www.prisma.io/docs/orm/migrations/applying-a-migration
- S39. Prisma docs index (Prisma ORM 8 release candidate, ORM 7 supported):
  https://www.prisma.io/docs/llms.txt
- S40. Flyway docs, Validate command:
  https://github.com/flyway/flyway/blob/flyway-13.12.1/documentation/Reference/Commands/Validate.md
- S41. Flyway docs, Repair command:
  https://github.com/flyway/flyway/blob/flyway-13.12.1/documentation/Reference/Commands/Repair.md
- S42. Flyway docs, Info command:
  https://github.com/flyway/flyway/blob/flyway-13.12.1/documentation/Reference/Commands/Info.md
- S43. Flyway docs, `validateOnMigrate`:
  https://github.com/flyway/flyway/blob/flyway-13.12.1/documentation/Reference/Configuration/Flyway%20Namespace/Flyway%20Validate%20On%20Migrate%20Setting.md
- S44. Flyway docs, `outOfOrder`:
  https://github.com/flyway/flyway/blob/flyway-13.12.1/documentation/Reference/Configuration/Flyway%20Namespace/Flyway%20Out%20Of%20Order%20Setting.md
- S45. Flyway docs, `lockRetryCount`:
  https://github.com/flyway/flyway/blob/flyway-13.12.1/documentation/Reference/Configuration/Flyway%20Namespace/Flyway%20Lock%20Retry%20Count%20Setting.md
- S46. Flyway docs, Callback Events (lines 20-75):
  https://github.com/flyway/flyway/blob/flyway-13.12.1/documentation/Reference/Callback%20Events.md
- S47. Flyway docs, Placeholders namespace (lines 15-24):
  https://github.com/flyway/flyway/blob/flyway-13.12.1/documentation/Reference/Configuration/Flyway%20Namespace/Flyway%20Placeholders%20Namespace.md
- S48. Flyway docs, Exit codes:
  https://github.com/flyway/flyway/blob/flyway-13.12.1/documentation/Reference/Exit%20codes%20and%20error%20codes.md
- S49. Flyway docs, Validate error codes (`FAILED_VERSIONED_MIGRATION`,
  `CHECKSUM_MISMATCH`):
  https://github.com/flyway/flyway/blob/flyway-13.12.1/documentation/Reference/Exit%20codes%20and%20error%20codes/Validate%20error%20codes.md
- S50. Flyway source: `internal/resolver/sql/SqlMigrationResolver.java` lines
  91-100, `internal/resolver/ResolvedMigrationImpl.java` lines 41-43,
  `internal/resolver/ChecksumCalculator.java` lines 37-41:
  https://github.com/flyway/flyway/tree/flyway-13.12.1/flyway-core/src/main/java/org/flywaydb/core/internal/resolver
- S51. Flyway source, `flyway-database-postgresql/.../PostgreSQLDatabase.java`
  lines 145-173:
  https://github.com/flyway/flyway/blob/flyway-13.12.1/flyway-database/flyway-database-postgresql/src/main/java/org/flywaydb/database/postgresql/PostgreSQLDatabase.java
- S52. Redgate Flyway, Repeatable migrations:
  https://documentation.red-gate.com/fd/repeatable-migrations-273973335.html
- S53. Redgate Flyway, Migration transaction handling:
  https://documentation.red-gate.com/fd/migration-transaction-handling-273973399.html
- S54. Redgate Flyway, Flyway schema history table (states):
  https://documentation.red-gate.com/fd/flyway-schema-history-table-273973417.html
- S55. Redgate Flyway, Conditionally executing migrations:
  https://documentation.red-gate.com/fd/conditionally-executing-migrations-275218530.html
- S56. Liquibase
  `liquibase-standard/src/main/java/liquibase/changelog/ChangeSet.java` lines
  70-79, 151, 187, 432-442, 494:
  https://github.com/liquibase/liquibase/blob/v5.0.4/liquibase-standard/src/main/java/liquibase/changelog/ChangeSet.java
- S57. Liquibase `precondition/core/PreconditionContainer.java` lines 27-31, 81:
  https://github.com/liquibase/liquibase/blob/v5.0.4/liquibase-standard/src/main/java/liquibase/precondition/core/PreconditionContainer.java
- S58. Liquibase `sqlgenerator/core/CreateDatabaseChangeLogTableGenerator.java`
  lines 52-65:
  https://github.com/liquibase/liquibase/blob/v5.0.4/liquibase-standard/src/main/java/liquibase/sqlgenerator/core/CreateDatabaseChangeLogTableGenerator.java
- S59. Liquibase command steps (`StatusCommandStep` line 54,
  `HistoryCommandStep` line 65, `ValidateCommandStep` line 29,
  `ChangelogSyncCommandStep` line 46, `MarkNextChangesetRanCommandStep` line 39,
  `ListLocksCommandStep` line 34, `ReleaseLocksCommandStep` line 44,
  `ClearChecksumsCommandStep` line 27, `UpdateTestingRollbackCommandStep` line
  39):
  https://github.com/liquibase/liquibase/tree/v5.0.4/liquibase-standard/src/main/java/liquibase/command/core
- S60. Liquibase `lockservice/StandardLockService.java` lines 257-298 and
  `GlobalConfiguration.java` lines 86-95:
  https://github.com/liquibase/liquibase/blob/v5.0.4/liquibase-standard/src/main/java/liquibase/lockservice/StandardLockService.java
- S61. Liquibase Secure 5.1, changelog-sync:
  https://docs.liquibase.com/commands/utility/changelog-sync.html
- S62. Liquibase Community 5.0.4, What are attributes?:
  https://docs.liquibase.com/community/user-guide-5-0-4/what-are-attributes
- S63. Liquibase Secure 5.1, What is a Changeset?:
  https://docs.liquibase.com/concepts/changelogs/changeset.html
- S64. Liquibase Secure 5.0, What are preconditions?:
  https://docs.liquibase.com/secure/user-guide-5-0/what-are-preconditions
- S65. Liquibase Community 5.0, What is a Changeset checksum?:
  https://docs.liquibase.com/community/user-guide-5-0/what-is-a-changeset-checksum
- S66. Laravel docs 13.x, Database: Migrations (lines 53-75 squashing, 164-190
  status, pretend, isolated):
  https://github.com/laravel/docs/blob/f3c3ee84420004d2a780947f66ff6d107d109fbc/migrations.md
- S67. Laravel docs 13.x, Database: Seeding (lines 10-14, 133-155):
  https://github.com/laravel/docs/blob/f3c3ee84420004d2a780947f66ff6d107d109fbc/seeding.md
- S68. Flyway docs, Tutorial: Repeatable Migrations:
  https://github.com/flyway/flyway/blob/flyway-13.12.1/documentation/Reference/Tutorials/Tutorial%20-%20Repeatable%20Migrations.md
- S69. ecto_sql `lib/ecto/adapters/postgres.ex` lines 28-45:
  https://github.com/elixir-ecto/ecto_sql/blob/v3.14.0/lib/ecto/adapters/postgres.ex#L28-L45
- S70. ecto_sql `lib/ecto/migration.ex` lines 225-243, 585-596:
  https://github.com/elixir-ecto/ecto_sql/blob/v3.14.0/lib/ecto/migration.ex
- S71. ecto_sql `lib/ecto/migration/schema_migration.ex` lines 11, 34:
  https://github.com/elixir-ecto/ecto_sql/blob/v3.14.0/lib/ecto/migration/schema_migration.ex
- S72. ecto_sql `lib/ecto/migrator.ex` line 534 and
  `lib/mix/tasks/ecto.migrations.ex` lines 17-48:
  https://github.com/elixir-ecto/ecto_sql/blob/v3.14.0/lib/ecto/migrator.ex#L534
- S73. ecto_sql `lib/mix/tasks/ecto.migrate.ex` lines 72-112:
  https://github.com/elixir-ecto/ecto_sql/blob/v3.14.0/lib/mix/tasks/ecto.migrate.ex#L72-L112
- S74. ecto_sql guide, Backfilling Data (lines 1-16, 18-103, 105-215, 370):
  https://github.com/elixir-ecto/ecto_sql/blob/v3.14.0/guides/backfilling_data.md
- S75. ecto_sql guide, Squashing Migrations:
  https://github.com/elixir-ecto/ecto_sql/blob/v3.14.0/guides/squashing_migrations.md
- S76. ecto_sql guide, Safe Ecto Migrations, Credits (lines 775-784):
  https://github.com/elixir-ecto/ecto_sql/blob/v3.14.0/guides/safe_migrations.md
- S77. laravel/framework
  `src/Illuminate/Database/Console/Migrations/MigrateCommand.php` lines 21,
  30-39:
  https://github.com/laravel/framework/blob/v13.40.0/src/Illuminate/Database/Console/Migrations/MigrateCommand.php
- S78. laravel/framework `src/Illuminate/Console/Command.php` lines 231-305
  (`--isolated`):
  https://github.com/laravel/framework/blob/v13.40.0/src/Illuminate/Console/Command.php#L231-L305
- S79. laravel/framework
  `src/Illuminate/Database/Migrations/DatabaseMigrationRepository.php` lines
  170-172:
  https://github.com/laravel/framework/blob/v13.40.0/src/Illuminate/Database/Migrations/DatabaseMigrationRepository.php#L170-L172
- S80. laravel/framework
  `src/Illuminate/Database/Schema/PostgresSchemaState.php` lines 20-24:
  https://github.com/laravel/framework/blob/v13.40.0/src/Illuminate/Database/Schema/PostgresSchemaState.php#L20-L24
- S81. Atlas, Migration directory integrity:
  https://atlasgo.io/concepts/migration-directory-integrity
- S82. Atlas, Applying migrations (`migrate apply`):
  https://atlasgo.io/versioned/apply
- S83. Atlas, Migration directory checkpoints:
  https://atlasgo.io/versioned/checkpoint
- S84. Atlas, Verifying migration safety (`migrate lint`):
  https://atlasgo.io/versioned/lint
- S85. Atlas, Testing migrations (`migrate test`):
  https://atlasgo.io/testing/migrate
- S86. atlas `cmd/atlas/internal/cmdapi/migrate.go` lines 152-157 (flags),
  896-899 (`migrate set`), 1167-1170 (`migrate validate`), 1301-1308 (tx modes,
  exec orders):
  https://github.com/ariga/atlas/blob/v1.3.0/cmd/atlas/internal/cmdapi/migrate.go
- S87. atlas `sql/migrate/dir.go` lines 655-680 (`NewHashFile`), 788-805
  (`Validate`): https://github.com/ariga/atlas/blob/v1.3.0/sql/migrate/dir.go
- S88. atlas `sql/migrate/migrate.go` lines 238-252 (`Revision`), 680-735
  (pending, baseline, checkpoint):
  https://github.com/ariga/atlas/blob/v1.3.0/sql/migrate/migrate.go
- S89. sqitch `lib/sqitch-deploy.pod` lines 47-84:
  https://github.com/sqitchers/sqitch/blob/v1.6.1/lib/sqitch-deploy.pod
- S90. sqitch `lib/sqitch-rework.pod`:
  https://github.com/sqitchers/sqitch/blob/v1.6.1/lib/sqitch-rework.pod
- S91. sqitch `lib/sqitch-verify.pod`:
  https://github.com/sqitchers/sqitch/blob/v1.6.1/lib/sqitch-verify.pod
- S92. sqitch `lib/sqitch-check.pod`:
  https://github.com/sqitchers/sqitch/blob/v1.6.1/lib/sqitch-check.pod
- S93. sqitch `lib/App/Sqitch/Engine.pm` lines 16, 1115-1140 and
  `lib/App/Sqitch/Engine/pg.pm` lines 288-294:
  https://github.com/sqitchers/sqitch/blob/v1.6.1/lib/App/Sqitch/Engine.pm
- S94. sqitch `lib/App/Sqitch/Engine/pg.sql` lines 36-49 (`changes`), 109-125
  (`events`):
  https://github.com/sqitchers/sqitch/blob/v1.6.1/lib/App/Sqitch/Engine/pg.sql
- S95. golang-migrate `migrate.go` lines 48-54 (`ErrDirty`), 365 (`Force`),
  730-752 (dirty then clean):
  https://github.com/golang-migrate/migrate/blob/v4.20.1/migrate.go
- S96. golang-migrate `database/postgres/postgres.go` lines 241, 355-373, 481:
  https://github.com/golang-migrate/migrate/blob/v4.20.1/database/postgres/postgres.go
- S97. golang-migrate `GETTING_STARTED.md` lines 36-44:
  https://github.com/golang-migrate/migrate/blob/v4.20.1/GETTING_STARTED.md
- S98. golang-migrate `FAQ.md` lines 62-71:
  https://github.com/golang-migrate/migrate/blob/v4.20.1/FAQ.md

### O: Online and background systems (`parts/online.md`)

GitLab (gitlab-org/gitlab, tag `v19.2.10-ee`, commit
99575648fb5f1496cc9f10776aace9ea20780677, unless noted):

- O1. Batched background migrations doc:
  https://gitlab.com/gitlab-org/gitlab/-/blob/v19.2.10-ee/doc/development/database/batched_background_migrations.md
- O2. `BatchedBackgroundMigrationHelpers`:
  https://gitlab.com/gitlab-org/gitlab/-/blob/v19.2.10-ee/lib/gitlab/database/migrations/batched_background_migration_helpers.rb
- O3. `BatchedMigration` model:
  https://gitlab.com/gitlab-org/gitlab/-/blob/v19.2.10-ee/lib/gitlab/database/background_migration/batched_migration.rb
- O4. `BatchedJob` model:
  https://gitlab.com/gitlab-org/gitlab/-/blob/v19.2.10-ee/lib/gitlab/database/background_migration/batched_job.rb
- O5. `BatchedMigrationRunner`:
  https://gitlab.com/gitlab-org/gitlab/-/blob/v19.2.10-ee/lib/gitlab/database/background_migration/batched_migration_runner.rb
- O6. `Batch::Optimizer`:
  https://gitlab.com/gitlab-org/gitlab/-/blob/v19.2.10-ee/lib/gitlab/database/batch/optimizer.rb
- O7. Background migration RSpec matchers:
  https://gitlab.com/gitlab-org/gitlab/-/blob/v19.2.10-ee/spec/support/matchers/background_migrations_matchers.rb
- O8. Generator template, enqueue spec:
  https://gitlab.com/gitlab-org/gitlab/-/blob/v19.2.10-ee/lib/generators/batched_background_migration/templates/queue_batched_background_migration_spec.template
- O8a. Generator template, job spec:
  https://gitlab.com/gitlab-org/gitlab/-/blob/v19.2.10-ee/lib/generators/batched_background_migration/templates/batched_background_migration_job_spec.template
- O9. Rake tasks:
  https://gitlab.com/gitlab-org/gitlab/-/blob/v19.2.10-ee/lib/tasks/gitlab/background_migrations.rake
- O10. Admin doc, Check migrations before upgrade:
  https://gitlab.com/gitlab-org/gitlab/-/blob/v19.2.10-ee/doc/update/background_migrations.md
- O11. Database required stops:
  https://gitlab.com/gitlab-org/gitlab/-/blob/v19.2.10-ee/doc/development/database/required_stops.md
- O12. Migration squashing:
  https://gitlab.com/gitlab-org/gitlab/-/blob/v19.2.10-ee/doc/development/database/migration_squashing.md
- O13. Housekeeper keep `OverdueFinalizeBackgroundMigration`:
  https://gitlab.com/gitlab-org/gitlab/-/blob/v19.2.10-ee/keeps/overdue_finalize_background_migration.rb
- O14. BBM doc at `v17.3.2-ee` (`finalize_after`):
  https://gitlab.com/gitlab-org/gitlab/-/blob/v17.3.2-ee/doc/development/database/batched_background_migrations.md
- O15. Dictionary template at `v17.3.2-ee`:
  https://gitlab.com/gitlab-org/gitlab/-/blob/v17.3.2-ee/lib/generators/batched_background_migration/templates/batched_background_migration_dictionary.template
  ; example dictionary file:
  https://gitlab.com/gitlab-org/gitlab/-/blob/v17.3.2-ee/db/docs/batched_background_migrations/alter_webhook_deleted_audit_event.yml
- O15a. Dictionary template at `v19.2.10-ee`:
  https://gitlab.com/gitlab-org/gitlab/-/blob/v19.2.10-ee/lib/generators/batched_background_migration/templates/batched_background_migration_dictionary.template
- O16. Matchers at `v15.0.0-ee` (`be_scheduled_migration`):
  https://gitlab.com/gitlab-org/gitlab/-/blob/v15.0.0-ee/spec/support/matchers/background_migrations_matchers.rb
- O17. Migration style guide:
  https://gitlab.com/gitlab-org/gitlab/-/blob/v19.2.10-ee/doc/development/migration_style_guide.md
- O18. Avoiding downtime in migrations:
  https://gitlab.com/gitlab-org/gitlab/-/blob/v19.2.10-ee/doc/development/database/avoiding_downtime_in_migrations.md

Shopify:

- O19. maintenance_tasks README at 6d6e4c0 (v2.17.0):
  https://github.com/Shopify/maintenance_tasks/blob/6d6e4c06881c35b16b2625904618f4c5e1371985/README.md
- O20. maintenance_tasks `task_job_concern.rb`:
  https://github.com/Shopify/maintenance_tasks/blob/6d6e4c06881c35b16b2625904618f4c5e1371985/app/jobs/concerns/maintenance_tasks/task_job_concern.rb
- O21. job-iteration README at a4e8b23 (v1.18.0):
  https://github.com/Shopify/job-iteration/blob/a4e8b2397c0a64521566502feca6d6d0afe0cd83/README.md
- O22. job-iteration, Iteration: how it works:
  https://github.com/Shopify/job-iteration/blob/a4e8b2397c0a64521566502feca6d6d0afe0cd83/guides/iteration-how-it-works.md
- O23. job-iteration, Best practices:
  https://github.com/Shopify/job-iteration/blob/a4e8b2397c0a64521566502feca6d6d0afe0cd83/guides/best-practices.md
- O24. job-iteration, Custom enumerator:
  https://github.com/Shopify/job-iteration/blob/a4e8b2397c0a64521566502feca6d6d0afe0cd83/guides/custom-enumerator.md
- O25. job-iteration, Throttling:
  https://github.com/Shopify/job-iteration/blob/a4e8b2397c0a64521566502feca6d6d0afe0cd83/guides/throttling.md

gh-ost (github/gh-ost at 2ed192cd39d8a5173b6ef7c4beaa746a2d3bf1aa, v1.1.11):

- O26. Cut-over:
  https://github.com/github/gh-ost/blob/2ed192cd39d8a5173b6ef7c4beaa746a2d3bf1aa/doc/cut-over.md
- O27. Throttle:
  https://github.com/github/gh-ost/blob/2ed192cd39d8a5173b6ef7c4beaa746a2d3bf1aa/doc/throttle.md
- O28. Command line flags:
  https://github.com/github/gh-ost/blob/2ed192cd39d8a5173b6ef7c4beaa746a2d3bf1aa/doc/command-line-flags.md
- O29. Interactive commands:
  https://github.com/github/gh-ost/blob/2ed192cd39d8a5173b6ef7c4beaa746a2d3bf1aa/doc/interactive-commands.md
- O30. Hooks:
  https://github.com/github/gh-ost/blob/2ed192cd39d8a5173b6ef7c4beaa746a2d3bf1aa/doc/hooks.md
- O31. Triggerless design:
  https://github.com/github/gh-ost/blob/2ed192cd39d8a5173b6ef7c4beaa746a2d3bf1aa/doc/triggerless-design.md
- O32. Resuming migrations:
  https://github.com/github/gh-ost/blob/2ed192cd39d8a5173b6ef7c4beaa746a2d3bf1aa/doc/resume.md
- O33. Testing on replica:
  https://github.com/github/gh-ost/blob/2ed192cd39d8a5173b6ef7c4beaa746a2d3bf1aa/doc/testing-on-replica.md

Percona:

- O34. pt-online-schema-change (Percona Toolkit 3.7.2):
  https://docs.percona.com/percona-toolkit/pt-online-schema-change.html
- O35. pt-table-checksum (Percona Toolkit 3.7.2):
  https://docs.percona.com/percona-toolkit/pt-table-checksum.html

Stripe and GitHub Scientist:

- O36. Stripe Engineering, Online migrations at scale (Jacqueline Xu,
  2017-02-02): https://stripe.com/blog/online-migrations
- O37. github/scientist README at 504a396 (v1.6.5):
  https://github.com/github/scientist/blob/504a396e987f655a21c6bf2ed57935aadaa40859/README.md

Vitess docs 24.0 (vitessio/website at 996c5369284f880291a14c902edcdefe2bbca388;
rendered at https://vitess.io/docs/24.0/):

- O38. Postponed migrations:
  https://github.com/vitessio/website/blob/996c5369284f880291a14c902edcdefe2bbca388/content/en/docs/24.0/user-guides/schema-changes/postponed-migrations.md
- O39. Audit and control:
  https://github.com/vitessio/website/blob/996c5369284f880291a14c902edcdefe2bbca388/content/en/docs/24.0/user-guides/schema-changes/audit-and-control.md
- O40. Revertible migrations:
  https://github.com/vitessio/website/blob/996c5369284f880291a14c902edcdefe2bbca388/content/en/docs/24.0/user-guides/schema-changes/revertible-migrations.md
- O41. Recoverable migrations:
  https://github.com/vitessio/website/blob/996c5369284f880291a14c902edcdefe2bbca388/content/en/docs/24.0/user-guides/schema-changes/recoverable-migrations.md
- O42. DDL strategies:
  https://github.com/vitessio/website/blob/996c5369284f880291a14c902edcdefe2bbca388/content/en/docs/24.0/user-guides/schema-changes/ddl-strategies.md
- O43. Managed online schema changes:
  https://github.com/vitessio/website/blob/996c5369284f880291a14c902edcdefe2bbca388/content/en/docs/24.0/user-guides/schema-changes/managed-online-schema-changes.md
- O44. VDiff:
  https://github.com/vitessio/website/blob/996c5369284f880291a14c902edcdefe2bbca388/content/en/docs/24.0/reference/vreplication/vdiff.md
- O45. MoveTables:
  https://github.com/vitessio/website/blob/996c5369284f880291a14c902edcdefe2bbca388/content/en/docs/24.0/reference/vreplication/movetables.md

PlanetScale:

- O46. Deploy requests:
  https://planetscale.com/docs/vitess/schema-changes/deploy-requests
- O47. Handling table and column renames:
  https://planetscale.com/docs/vitess/schema-changes/handling-table-and-column-renames
- O48. Backward compatible database changes (Taylor Barnett, 2023-05-09):
  https://planetscale.com/blog/backward-compatible-databases-changes

Expand/contract, flags, backfills:

- O49. Danilo Sato, ParallelChange (martinfowler.com, 2014-05-13):
  https://martinfowler.com/bliki/ParallelChange.html
- O50. LaunchDarkly, Migration flags (overview):
  https://launchdarkly.com/docs/home/flags/migration
- O51. LaunchDarkly, Performing multi-stage migrations with migration flags:
  https://launchdarkly.com/docs/guides/flags/migrations
- O52. Notion, Herding elephants: Lessons learned from sharding Postgres at
  Notion (Garrett Fidalgo, 2021-10-06):
  https://www.notion.com/blog/sharding-postgres-at-notion
- O53. Figma, How Figma's databases team lived to tell the scale (Sammy Steele,
  2024-03-14):
  https://www.figma.com/blog/how-figmas-databases-team-lived-to-tell-the-scale/

Convex and this repo:

- O54. Convex docs, Limits: https://docs.convex.dev/production/state/limits
- O55. Convex docs, Schemas (schema validation, staged validators):
  https://docs.convex.dev/database/schemas
- O56. This repo, `docs/research/baseline-prior-art.md`.
- O57. This repo, `docs/research/problem-statement.md`.

### N: Document, NoSQL and local-first systems (`parts/nosql-localfirst.md`)

- N1. MongoDB Manual, Maintain Different Schema Versions:
  https://www.mongodb.com/docs/manual/data-modeling/design-patterns/data-versioning/schema-versioning/
- N2. MongoDB Blog, Building with Patterns: The Schema Versioning Pattern (Ken
  W. Alger, Daniel Coupal, 2019-04-19, updated 2019-07-12):
  https://www.mongodb.com/blog/post/building-with-patterns-the-schema-versioning-pattern
- N3. MongoDB Manual 9.0, Specify Validation Level for Existing Documents:
  https://www.mongodb.com/docs/manual/core/schema-validation/specify-validation-level/
- N4. Mongock docs v5, Migration (ChangeUnit methods, attributes, best
  practices): https://docs.mongock.io/v5/migration/index.html (source:
  flamingock/mongock-docs@e49c8b6 `site/v5/migration/migration.md` lines 34-58,
  62-71, 125-148)
- N5. Mongock docs v5, Technical overview, Mongock process:
  https://docs.mongock.io/v5/technical-overview/index.html
  (`site/v5/technical-overview/technical-overview.md` lines 51-70, section
  "Mongock process")
- N6. Mongock docs v5, Runner configuration:
  https://docs.mongock.io/v5/runner/index.html (`site/v5/runner/runner.md` lines
  48, 55-70)
- N7. Mongock docs v5, Driver (lock settings):
  https://docs.mongock.io/v5/driver/index.html (`site/v5/driver/driver.md` lines
  44-47)
- N8. Mongock docs v5, Transactions:
  https://docs.mongock.io/v5/features/transactions/index.html
- N9. Mongock docs v5, Legacy migration:
  https://docs.mongock.io/v5/features/legacy-migration/index.html
  (`site/v5/features/features-legacy-migration.md` lines 18-90)
- N10. Mongock docs v5, CLI operations:
  https://docs.mongock.io/v5/cli/operations/index.html
- N11. Mongock docs v5, Testing: https://docs.mongock.io/v5/testing/index.html
- N12. Mongock docs v5, Events:
  https://docs.mongock.io/v5/features/events/index.html
  (`site/v5/features/features-events.md` lines 22-26)
- N13. flamingock/mongock `mongock-5.5.1` (70643af),
  `mongock-core/mongock-runner/mongock-runner-core/src/main/java/io/mongock/runner/core/executor/ChangeExecutorBase.java`
  lines 220-278:
  https://github.com/flamingock/mongock/blob/70643afce114aec18c4483bc9d08de469f1f944a/mongock-core/mongock-runner/mongock-runner-core/src/main/java/io/mongock/runner/core/executor/ChangeExecutorBase.java#L220-L278
- N14. Same tag,
  `mongock-core/mongock-driver/mongock-driver-api/src/main/java/io/mongock/driver/api/entry/ChangeEntryService.java`
  lines 37-49:
  https://github.com/flamingock/mongock/blob/70643afce114aec18c4483bc9d08de469f1f944a/mongock-core/mongock-driver/mongock-driver-api/src/main/java/io/mongock/driver/api/entry/ChangeEntryService.java#L37-L49
- N15. Same tag, `.../driver/api/entry/ChangeState.java` lines 3-9:
  https://github.com/flamingock/mongock/blob/70643afce114aec18c4483bc9d08de469f1f944a/mongock-core/mongock-driver/mongock-driver-api/src/main/java/io/mongock/driver/api/entry/ChangeState.java
- N16. Same tag, `.../executor/operation/migrate/MigrateExecutorBase.java` lines
  45-73 and `.../executor/system/SystemUpdateExecutor.java` lines 55-111:
  https://github.com/flamingock/mongock/blob/70643afce114aec18c4483bc9d08de469f1f944a/mongock-core/mongock-runner/mongock-runner-core/src/main/java/io/mongock/runner/core/executor/system/SystemUpdateExecutor.java#L55-L111
- N17. Same tag, `.../executor/system/changes/SystemChangeUnit00001.java` lines
  18-46:
  https://github.com/flamingock/mongock/blob/70643afce114aec18c4483bc9d08de469f1f944a/mongock-core/mongock-runner/mongock-runner-core/src/main/java/io/mongock/runner/core/executor/system/changes/SystemChangeUnit00001.java
- N18. Same tag,
  `mongock-core/mongock-api/src/main/java/io/mongock/api/annotations/ChangeUnit.java`
  lines 10-115:
  https://github.com/flamingock/mongock/blob/70643afce114aec18c4483bc9d08de469f1f944a/mongock-core/mongock-api/src/main/java/io/mongock/api/annotations/ChangeUnit.java
- N19. Same tag, `.../executor/MongockRunnerImpl.java` lines 51-70:
  https://github.com/flamingock/mongock/blob/70643afce114aec18c4483bc9d08de469f1f944a/mongock-core/mongock-runner/mongock-runner-core/src/main/java/io/mongock/runner/core/executor/MongockRunnerImpl.java#L51-L70
- N20. seppevs/migrate-mongo `v14.0.7` (1f5e5f9), `lib/actions/up.js` lines
  6-59:
  https://github.com/seppevs/migrate-mongo/blob/1f5e5f953491042ea1c9d607ba71a4b264e0b611/lib/actions/up.js
- N21. Same tag, `lib/actions/status.js` lines 4-32:
  https://github.com/seppevs/migrate-mongo/blob/1f5e5f953491042ea1c9d607ba71a4b264e0b611/lib/actions/status.js
- N22. Same tag, `lib/utils/lock.js` lines 3-36:
  https://github.com/seppevs/migrate-mongo/blob/1f5e5f953491042ea1c9d607ba71a4b264e0b611/lib/utils/lock.js
- N23. Same tag, `samples/esm/migrate-mongo-config.js` lines 22-36 and
  `README.md` lines 321-370 (transactions, file hash):
  https://github.com/seppevs/migrate-mongo/blob/1f5e5f953491042ea1c9d607ba71a4b264e0b611/README.md
- N24. Same tag, `lib/actions/down.js` lines 6-63:
  https://github.com/seppevs/migrate-mongo/blob/1f5e5f953491042ea1c9d607ba71a4b264e0b611/lib/actions/down.js
- N25. Prisma docs, MongoDB (no Migrate, `db push`, data migration strategies):
  https://www.prisma.io/docs/orm/overview/databases/mongodb
- N26. Firebase, Best practices for Cloud Firestore (migrating traffic to a new
  collection, 500/50/5):
  https://firebase.google.com/docs/firestore/best-practices
- N27. Firebase, Modify data with Firestore Pipeline operations (DML):
  https://firebase.google.com/docs/firestore/pipelines/dml
- N28. Firebase, Export and import data (import does not trigger Cloud
  Functions):
  https://firebase.google.com/docs/firestore/manage-data/export-import
- N29. kevlened/fireway `1.1.0` (884c78b, repository archived), `src/index.js`
  lines 28-40 (dry run), 300-385 (state and execution) and `README.md` lines 63,
  130-155:
  https://github.com/kevlened/fireway/blob/884c78b9d55239b877f33acf1173dfc0a99c96d3/src/index.js
- N30. AWS Database Blog, Evolve your Amazon DynamoDB table's data model
  (Imhoertha Ojior, 2025-07-10):
  https://aws.amazon.com/blogs/database/evolve-your-amazon-dynamodb-tables-data-model/
- N31. AWS Database Blog, Bulk update Amazon DynamoDB tables with AWS Step
  Functions (Chris Gillespie, 2024-03-20):
  https://aws.amazon.com/blogs/database/bulk-update-amazon-dynamodb-tables-with-aws-step-functions/
- N32. AWS Database Blog, Cost-effective bulk processing with Amazon DynamoDB
  (Jason Hunter, 2023-05-30):
  https://aws.amazon.com/blogs/database/cost-effective-bulk-processing-with-amazon-dynamodb/
- N33. AWS DynamoDB Developer Guide, Scanning tables (pagination, read
  consistency, parallel scan):
  https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html
- N34. AWS DynamoDB Developer Guide, Change data capture for DynamoDB Streams:
  https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html
- N35. AWS DynamoDB Developer Guide, Managing global secondary indexes (phases,
  backfill, violations):
  https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.OnlineOps.html
- N36. AWS Database Blog, Introducing bulk put items for Amazon DynamoDB (Lee
  Hannigan, Anugrah Prakash, 2026-11-05):
  https://aws.amazon.com/blogs/database/introducing-bulk-put-items-for-amazon-dynamodb-load-data-from-amazon-s3-into-existing-tables-at-scale/
- N37. MongoDB, Atlas Device SDK for Node.js, Change an Object Model:
  https://www.mongodb.com/docs/atlas/device-sdks/sdk/node/model-data/modify-an-object-schema/
  (markdown: same URL with `.md`)
- N38. MongoDB, Atlas Device SDK for Swift, Change an Object Model:
  https://www.mongodb.com/docs/atlas/device-sdks/sdk/swift/model-data/change-an-object-model/
- N39. MongoDB, Atlas App Services, Update Your Data Model (synced schema
  changes):
  https://www.mongodb.com/docs/atlas/app-services/sync/data-model/update-schema/
- N40. MongoDB, Atlas App Services, Make Breaking Schema Changes (partner
  collections):
  https://www.mongodb.com/docs/atlas/app-services/sync/data-model/migrate-schema-partner-collection/
- N41. Couchbase Sync Gateway docs, Sync Function:
  https://docs.couchbase.com/sync-gateway/current/sync-function.html
- N42. Couchbase Developer Portal, Tutorial: Schema Versioning:
  https://developer.couchbase.com/tutorial-schema-versioning/
- N43. rocicorp/mono `zero/v1.11.4` (be94346),
  `packages/replicache/src/replicache-options.ts` lines 64-69,
  `src/sync/push.ts` lines 58-70, `src/sync/pull.ts` lines 61-70:
  https://github.com/rocicorp/mono/blob/be94346faaf4ee7e7b2cf983f6e5accae3a6b4fb/packages/replicache/src/replicache-options.ts#L64-L69
- N44. Same tag, `packages/replicache/src/make-idb-name.ts` lines 10-21 and
  `src/new-client-channel.ts` lines 40-100:
  https://github.com/rocicorp/mono/blob/be94346faaf4ee7e7b2cf983f6e5accae3a6b4fb/packages/replicache/src/new-client-channel.ts#L40-L100
- N45. Same tag, `packages/replicache/src/replicache.ts` lines 232-256,
  `src/types.ts` lines 74-88, `src/error-responses.ts` lines 32-58:
  https://github.com/rocicorp/mono/blob/be94346faaf4ee7e7b2cf983f6e5accae3a6b4fb/packages/replicache/src/replicache.ts#L232-L256
- N46. Replicache docs, Launch to Production:
  https://doc.replicache.dev/howto/launch
- N47. Replicache docs, Pull Endpoint Reference:
  https://doc.replicache.dev/reference/server-pull
- N48. Zero docs, Schema, section "Schema Changes":
  https://zero.rocicorp.dev/docs/schema
- N49. rocicorp/mono `zero/v1.11.4`,
  `packages/zero-cache/src/services/view-syncer/client-schema.ts` lines 16-141:
  https://github.com/rocicorp/mono/blob/be94346faaf4ee7e7b2cf983f6e5accae3a6b4fb/packages/zero-cache/src/services/view-syncer/client-schema.ts#L16-L141
- N50. Same tag, `packages/zero-client/src/client/zero.ts` lines 641-662
  (schemaVersion hash), 1640-1655 (error handling), 1760-1772 (client schema on
  connect):
  https://github.com/rocicorp/mono/blob/be94346faaf4ee7e7b2cf983f6e5accae3a6b4fb/packages/zero-client/src/client/zero.ts#L641-L662
- N51. ElectricSQL docs, Shapes (schema changes, shape deletion, immutability):
  https://electric.ax/docs/guides/shapes
- N52. Convex docs, Deploying Your App to Production, "Making safe changes":
  https://docs.convex.dev/production
- N53. get-convex/convex-js `npm/1.49.0` (58c383e), `src/browser/sync/client.ts`
  lines 339 and 1112:
  https://github.com/get-convex/convex-js/blob/58c383e46f9984eeea6105e0ba7fe94b2a3db1b5/src/browser/sync/client.ts#L339
- N54. Convex docs, `npx convex function-spec`:
  https://docs.convex.dev/cli/reference/function-spec
- N55. Convex docs, OCC and Atomicity ("Snapshot Isolation vs Serializability"):
  https://docs.convex.dev/database/advanced/occ

### P: Prior note (`baseline-prior-art.md`)

- P1. Rails Guides, Active Record Migrations:
  https://guides.rubyonrails.org/active_record_migrations.html (sections 4.3,
  6.1, 8, 9, 10.2)
- P2. Same page, "Migrations and Seed Data":
  https://guides.rubyonrails.org/active_record_migrations.html#migrations-and-seed-data
- P3. Rails API, `ActiveRecord::CounterCache::ClassMethods#reset_counters`:
  https://api.rubyonrails.org/classes/ActiveRecord/CounterCache/ClassMethods.html
- P4. Django 5.2, Migrations, squashing and data migrations:
  https://docs.djangoproject.com/en/5.2/topics/migrations/
- P5. Django 5.2, Migration operations (`RunSQL`, `RunPython`, `elidable`):
  https://docs.djangoproject.com/en/5.2/ref/migration-operations/
- P6. Prisma, Baselining a database:
  https://www.prisma.io/docs/orm/prisma-migrate/workflows/baselining
- P7. Prisma, Squashing migrations:
  https://www.prisma.io/docs/orm/prisma-migrate/workflows/squashing-migrations
- P8. Redgate Flyway, Baseline migrations:
  https://documentation.red-gate.com/fd/baseline-migrations-273973336.html
- P9. Redgate Flyway, Baseline On Migrate setting:
  https://documentation.red-gate.com/fd/flyway-baseline-on-migrate-setting-277578974.html
- P10. Laravel 12.x, Migrations, Squashing Migrations:
  https://laravel.com/docs/12.x/migrations#squashing-migrations
- P11. Ecto SQL, `mix ecto.load`:
  https://ecto-sql.hexdocs.pm/Mix.Tasks.Ecto.Load.html
- P12. GitLab, Batched background migrations:
  https://docs.gitlab.com/development/database/batched_background_migrations/
- P12a. GitLab, Migration squashing:
  https://docs.gitlab.com/development/database/migration_squashing/
- P13. get-convex/migrations v0.3.6, component schema:
  https://github.com/get-convex/migrations/blob/v0.3.6/src/component/schema.ts
- P14. get-convex/migrations v0.3.6, component `lib.ts` (`migrate` lines 43-207,
  chaining 128-175, `cancel`/`cancelAll`/`clearAll` 280-360):
  https://github.com/get-convex/migrations/blob/v0.3.6/src/component/lib.ts
- P15. get-convex/migrations v0.3.6, README (serial behavior,
  `getStatus --watch` line 328, production deploy line 357, `runToCompletion`
  line 462): https://github.com/get-convex/migrations/blob/v0.3.6/README.md
- P16. get-convex/migrations PR #77 (open), `docs/team-workflows.mdx` at
  1dbb9e5: https://github.com/get-convex/migrations/pull/77
- P17. get-convex/migrations CHANGELOG:
  https://github.com/get-convex/migrations/blob/main/CHANGELOG.md
- P18. get-convex/migrations v0.3.6, client `index.ts` (`runner` line 146,
  `anyInProgress` line 204, `runToCompletion` line 778):
  https://github.com/get-convex/migrations/blob/v0.3.6/src/client/index.ts
- P19. Convex Stack, Seeding Data for Preview Deployments:
  https://stack.convex.dev/seeding-data-for-preview-deployments
- P20. Convex docs, `npx convex deploy`:
  https://docs.convex.dev/cli/reference/deploy
- P21. Convex docs, Preview deployments:
  https://docs.convex.dev/production/hosting/preview-deployments
- P22. Convex Stack, Intro to Migrations:
  https://stack.convex.dev/intro-to-migrations
- P23. Convex Stack, Migrating Data with Mutations:
  https://stack.convex.dev/migrating-data-with-mutations
- P24. Convex Stack, Lightweight Migrations:
  https://stack.convex.dev/lightweight-zero-downtime-migrations
- P25. Convex docs, `npx convex dev`: https://docs.convex.dev/cli/reference/dev
- P26. Convex docs, Limits: https://docs.convex.dev/production/state/limits
- P27. get-convex/agent-skills, `convex-migrate-rehearse` at f60629d:
  https://github.com/get-convex/agent-skills/blob/f60629d7c6c1f27eb58a56260546d2445049274d/skills/convex-migrate-rehearse/SKILL.md
- P28. Stripe Engineering, Online migrations at scale (Jacqueline Xu,
  2017-02-02): https://stripe.com/blog/online-migrations
- P29. LaunchDarkly, Migration flags:
  https://launchdarkly.com/docs/home/flags/migration
- P30. get-convex/convex-helpers README, Triggers (line 1217-1225 at 964f2d4):
  https://github.com/get-convex/convex-helpers/blob/964f2d4ec97a19bbc258ddbdbbb522044fec230c/packages/convex-helpers/README.md#triggers
- P31. get-convex/aggregate README, Operations (lines 420-505 at 7583a1e):
  https://github.com/get-convex/aggregate/blob/7583a1e0d2dda716dc51f11955944d47077e583f/README.md#operations
- P32. Convex docs, Data import:
  https://docs.convex.dev/database/import-export/import
- P33. Convex docs, `npx convex import`:
  https://docs.convex.dev/cli/reference/import
- P34. Convex docs, Backup and restore:
  https://docs.convex.dev/database/backup-restore
- P35. PostgreSQL commit, "Fix pg_dump/pg_restore to emit REFRESH MATERIALIZED
  VIEW commands last" (Tom Lane, 2017-08-03):
  https://www.postgresql.org/message-id/E1ddNne-0001jw-Vx@gemulon.postgresql.org
