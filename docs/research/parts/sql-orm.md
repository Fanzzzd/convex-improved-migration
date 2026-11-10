# Research part: SQL and ORM migration systems

Appendix of `docs/research/industry-survey.md`. Citations `[Sn]` refer to the
Sources list at the end of this file.

Date: 2026-11-10. Slice of the industry survey in
`docs/research/industry-survey.md`.

This part extends `docs/research/baseline-prior-art.md` [S1]. That note already
covers Rails schema load and seeds, Django squash and `elidable`, Prisma
baseline and squash, Flyway baseline migrations, Laravel `schema:dump`, Ecto
`ecto.load` and GitLab finalize. This part does not repeat them. It adds the
mechanisms behind them, plus Shopify `maintenance_tasks`, `data_migrate`,
Liquibase, Atlas, sqitch and golang-migrate.

Method. Source code was read from shallow clones at pinned tags. No cloned code
was run. Docs were read from the official sites or from the docs folders inside
the pinned repos. Pinned commits are listed in the Sources section.

## Short answer

- Every system here can record a migration as done without running it. Rails,
  `data_migrate`, Django, Prisma, Flyway, Liquibase, Atlas and golang-migrate
  all ship a command or load step for this
  [S4][S15][S16][S29][S37][S61][S86][S88][S95]. Prisma 8 and Atlas verify or
  guard the database state before they write that record [S37][S88].
- The systems that model data changes best attach a check to each change. Prisma
  8 compiles a data transform into a precheck, an execute step and a postcheck,
  and skips the step when the postcheck already passes [S34][S35]. sqitch runs a
  verify script per change and reverts on failure [S89][S91]. Liquibase
  preconditions can mark a changeset as ran when a SQL check fails [S57][S64].
- Re-running derived objects is a solved pattern in SQL tools. Flyway repeatable
  migrations re-run whenever their checksum changes and always run after
  versioned migrations [S52]. Liquibase has `runOnChange` and `runAlways` [S62].
  This is the closest analogue to rebuilding counters and search postings.
- Failure is sticky everywhere. golang-migrate marks the database dirty and
  refuses to continue until `force` [S95][S97]. Flyway records a failed row that
  `repair` must remove [S53][S54]. Prisma blocks `migrate deploy` until
  `migrate resolve` [S29]. Atlas records how many statements of a file ran and
  resumes from the failed statement [S82][S88].
- Every CLI here runs migrations in the foreground and returns a non-zero exit
  code on failure, with three exceptions found. `maintenance_tasks perform` only
  enqueues a job [S9]. Laravel `migrate --isolated` exits 0 when another run
  holds the lock [S66][S78]. Laravel `--graceful` exits 0 even on error [S77].
- Shopify `maintenance_tasks` is the closest model for long data backfills. It
  gives cursor-based resumable iteration, pause, resume, cancel, throttling,
  typed arguments, a run history table and error reporting [S8]. It does not
  wait, does not chain tasks, and says tasks should be ephemeral [S8][S9].

## Rails (core Active Record)

Baseline. `db:schema:load` ends with `assume_migrated_upto_version`. That method
inserts the schema version and every local migration version below it into
`schema_migrations` without running them [S4][S5]. The baseline is implicit: any
migration file older than the dumped version is marked as run. The rest is in
[S1].

History table. `schema_migrations` has one column, `version` [S6]. It stores no
timestamps, checksums or errors.

Pruning. `db:migrate:status` lists versions that are in the table but have no
file as `********** NO FILE **********` [S3]. Deleting old files is therefore
visible but harmless.

Failure. Each migration runs in its own DDL transaction unless it calls
`disable_ddl_transaction!` [S3]. On error the migrator reports "An error has
occurred, this and all later migrations canceled" [S3]. Earlier migrations in
the same run stay applied, because each one commits its version row inside its
own transaction [S3].

Concurrency. The migrator takes a database advisory lock. On PostgreSQL this is
`pg_try_advisory_lock`, which does not wait [S7]. If the lock is taken, Rails
raises `ConcurrentMigrationError` with "Cannot run migrations because another
migration process is currently running" [S3]. After it gets the lock it reloads
`schema_migrations` in case another process changed it [S3].

Data migrations. The Rails guide advises against data migrations in migration
files and points to `maintenance_tasks` [S1][S2].

## Shopify `maintenance_tasks` (v2.17.0)

Scope. The README says tasks are for data changes, not schema changes. "If your
task updates your database schema instead of data, use a migration." Seed data
belongs in `db/seeds.rb`. Tasks "should be ephemeral" and "should not repeat".
"If your application can't handle a half-completed migration, maintenance tasks
are probably the wrong tool" because tasks can be paused and cancelled halfway
[S8].

Task API. A task subclasses `MaintenanceTasks::Task` and implements `collection`
(an Active Record relation or an array) and `process(item)`. An optional `count`
overrides the computed `tick_total` [S8]. Other shapes:

- `collection_batch_size(n)` sets the fetch batch size; the default is 100 [S8].
- Returning `Post.in_batches` from `collection` makes `process` receive a whole
  batch [S8].
- `csv_collection` iterates rows of an uploaded CSV file and requires Active
  Storage. `csv_collection(in_batches: n)` gives batches of rows [S8].
- `no_collection` tasks run `process` once [S8].
- `enumerator_builder(cursor:)` lets a task iterate any source. It yields
  `[item, cursor]` pairs and the gem persists the cursor as a string, or as JSON
  when JSON cursors are enabled [S8].
- `cursor_columns` changes the ordering columns. "If cursor columns values
  change during an iteration, records may be skipped or yielded multiple times"
  [S8].

Arguments. Parameters are Active Model attributes on the task, validated with
Active Model validations "before a Task is enqueued" [S8]. Inclusion validators
render a dropdown in the web UI [S8]. The CLI takes `--arguments key:value`
pairs [S8].

Execution and resume. The gem runs on Active Job through the `job-iteration`
gem. A task "can safely be interrupted, re-enqueued and resumed without any
intervention at the end of an iteration" [S8]. By default a job is interrupted
after 5 minutes and re-enqueued with its cursor [S8]. If a worker is killed
before it saves the cursor, "at least one iteration may run again", so `process`
must be idempotent [S8].

Pause, resume, cancel. Statuses are `enqueued`, `running`, `succeeded`,
`cancelling`, `cancelled`, `interrupted`, `pausing`, `paused` and `errored`
[S10]. `errored`, `succeeded` and `cancelled` are completed states; a cancelled
run "cannot be resumed" [S8][S10]. A run stuck in `pausing` or `cancelling` for
longer than `stuck_task_duration` (default 5 minutes) can be cancelled again or
force-paused [S8]. The job reloads run status every second by default
(`status_reload_frequency`, per task `reload_status_every`), which bounds how
fast pause and cancel take effect [S8]. Status transitions use optimistic
locking with `lock_version` and retry on `StaleObjectError` [S10][S11].

Throttling. `throttle_on(backoff:) { condition }` interrupts the task and
retries after the backoff when the block returns true. The default backoff is 30
seconds. Shopify's condition checks MySQL replication lag and thread counts
[S8].

Errors. Exceptions are rescued and stored on the run: `error_class`,
`error_message` and a cleaned `backtrace` [S10]. They are also sent to
`Rails.error.report` with `task_name`, `run_id`, `tick_count` and
`errored_element` [S8]. `report_on(MyError)` reports listed errors and keeps
iterating; `rescue_from` allows custom handling [S8]. Callbacks: `after_start`,
`after_pause`, `after_interrupt`, `after_cancel`, `after_complete`,
`after_error` [S8].

Run history. Each run is a row in `maintenance_tasks_runs` with `task_name`,
`started_at`, `ended_at`, `time_running`, `tick_count`, `tick_total`, `job_id`,
`cursor`, `status`, `error_class`, `error_message`, `backtrace`, later
`arguments`, `lock_version`, `metadata` and `cursor_is_json` [S11].
`MaintenanceTasks.metadata` can record who started a run [S8]. Lifecycle events
are published as Active Support notifications such as
`succeeded.maintenance_tasks` [S8]. A succeeded task is marked stale after
`task_staleness_threshold`, default 30 days [S8].

Waiting. `bundle exec maintenance_tasks perform Task` calls `Runner.run`, prints
"was enqueued" and returns [S9][S13]. It does not wait for the run. Its `rescue`
prints the error and does not re-raise, so from the source an enqueue error does
not appear to produce a non-zero exit code [S9]. There is no chaining of tasks.

Concurrency. I found no validation that blocks a second active run of the same
task. The index page code sorts tasks "when a Task has multiple active Runs
created at the same time", so the code expects it [S12].

Pruning. Step 4 of the documented workflow is "Optionally, delete the Task code
if you no longer need it" [S8].

Testing. The generator creates a test file. The README recommends testing
`process` directly, for example `Maintenance::UpdatePostsTask.process(post)`,
and `collection` and `count` if complex [S8]. CSV tasks are tested by passing a
hash to `process`; parameterized tasks by instantiating the task and setting
attributes [S8].

## `data_migrate` gem (11.4.0)

`data_migrate` keeps data migrations in `db/data` with their own table, run in
version order alongside schema migrations by `db:migrate:with_data` [S14].
Relevant pieces:

- `data:dump` writes `db/data_schema.rb` with the current data version.
  `data:schema:load` loads it "without running the data migrations" [S14]. The
  loader inserts the dumped version and every local data migration version below
  it into the data migrations table [S15]. This is a baseline for data
  migrations, built the same way as Rails `assume_migrated_upto_version`
  [S4][S15].
- `db:prepare:with_data` "Runs setup if database does not exist, or runs data
  and schema migrations if it does" [S14].
- `data:abort_if_pending_migrations` raises when data migrations are pending,
  and an optional development-only middleware raises
  `DataMigrate::PendingMigrationError` on page load [S14].

## Django (6.0.10)

Mark as applied. `migrate --fake` marks migrations "as run without actually
running them" [S16]. The docs warn it "runs the risk of putting the migration
state table into a state where manual recovery will be needed" [S21].
`--fake-initial` fakes an initial migration only if its tables already exist,
and "Django will only check for an existing table name" [S16]. The executor
implements this with `detect_soft_applied` [S17].

Squash and `replaces`. When a squashed migration is recorded, the executor also
records every migration it replaces [S17]. `check_replacements` runs on every
`migrate` and marks a squashed migration applied once all its replaced
migrations are applied. The comment explains this covers a squash pushed to a
deployment that already ran the originals [S17]. Docs then describe removing old
files and the `replaces` attribute in a later release [S20].

Pruning. `migrate --prune` deletes `django_migrations` rows whose files no
longer exist [S16][S21]. It requires an app label, and it refuses to run while a
squashed migration that still has `replaces` would lose its replaced rows [S16].

Check and status. `migrate --check` exits with status 1 when unapplied
migrations exist and applies nothing [S16][S21]. `showmigrations --list` marks
applied migrations with `[X]` and shows applied datetimes at verbosity 2 [S21].
`django_migrations` has `app`, `name` and `applied` [S18].

Atomicity. On PostgreSQL and SQLite each migration runs in one transaction by
default. `atomic = False` turns that off, and `RunPython(atomic=True)`
re-enables it per operation [S20]. The how-to shows a non-atomic data migration
that updates a large table in batches of 1000, each in its own
`transaction.atomic()` block [S22].

Reverse. `RunPython` without `reverse_code` raises
`NotImplementedError("You cannot reverse this operation")` when migrating
backwards. `RunPython.noop` exists for a no-op reverse [S19]. `elidable` is an
argument of `RunPython` [S19]; its squash behavior is in [S1].

Historical models. `RunPython` code must use `apps.get_model()` historical
models. Importing models directly "may work initially but will fail in the
future when you try to rerun old migrations (commonly, when you set up a new
installation...)" [S20].

Concurrency. I found no lock in `executor.py`, `recorder.py` or `migrate.py`
[S16][S17][S18]. Two deployers can run `migrate` at the same time.

Testing. The test runner runs migrations when it creates the test database.
`TEST: {"MIGRATE": False}` skips them [S23].

## Prisma

Prisma has two current lines. Prisma ORM 7 is "fully supported" and Prisma ORM 8
is a release candidate with a new migration model [S39].

### Prisma ORM 7 (classic Prisma Migrate)

History table. `_prisma_migrations` has `id`, `checksum`, `finished_at`,
`migration_name`, `logs`, `rolled_back_at`, `started_at` and
`applied_steps_count` [S33].

Deploy. `migrate deploy` applies pending migrations and warns when an applied
migration's file changed ("The following migrations have been modified since
they were applied") [S24]. It does not warn when an applied migration is
missing, does not detect drift and does not use a shadow database [S24][S26].

Drift and the shadow database. `migrate dev` re-runs the migration history in a
temporary shadow database, introspects it and compares it with the development
database to report drift [S27]. Edited or deleted migration files are detected
through the `checksum` column, not the shadow database [S27]. Prisma says not to
edit or delete applied migrations [S28].

Failure and resolve. A failed migration stores its error in `logs`. "Until you
recover from the failed state, further migrations using `prisma migrate deploy`
are impossible" [S29]. A migration can be "partially executed" [S29].
`migrate resolve --rolled-back` lets it run again. `migrate resolve --applied`
records it as applied without running its SQL, which is also how hotfixes are
reconciled [S29].

Status and diff. `migrate status` exits 1 when there are unapplied migrations,
diverged history, no migration table or failed migrations [S25].
`migrate diff --exit-code` returns 0 for empty, 1 for error and 2 for a
non-empty diff [S30].

Concurrency. `deploy`, `dev` and `resolve` take an advisory lock with a fixed 10
second timeout; on timeout the user must run the command again [S24]. On
PostgreSQL the engine runs `SELECT pg_advisory_lock(72707369)` under that
timeout [S33].

Data migrations. Prisma's expand-and-contract guide runs the data step as a
standalone TypeScript script started with an npm script against production
[S31]. It is not tracked in `_prisma_migrations`. Seeding runs only through
`prisma db seed` in v7; automatic seeding during `migrate dev` and
`migrate reset` was removed [S32].

### Prisma ORM 8 (release candidate)

State model. The database stores a marker, which records the contract state (a
hash) it matches. `db migrate` finds a path through the migration graph from the
marker to the target contract [S38]. It fails with `MIGRATION.MARKER_MISMATCH`
when the marker names a state outside the history [S38].

Checks per operation. Each compiled operation in `ops.json` has a precheck,
execute statements and a postcheck [S34]. `db migrate` runs the postcheck first
and skips the operation if it passes. Otherwise it runs precheck, statements and
postcheck, and stops if a check fails. After all operations it checks the
database against the contract before it updates the marker [S34]. Operations
have an `operationClass` of additive, widening, destructive or data [S34].

Data transforms. `migration plan --backfill User.displayName` splits a change
into add nullable column, `dataTransform` and set not null [S35]. A
`dataTransform` takes `check`, which returns rows that still need work, and
`run`, which changes them [S35]. The compiled form has a precheck "has work to
do", the update, and a postcheck "resolved all violations" [S35]. A backfill
that needs a column the migration drops is written against a hand-made
intermediate contract [S35].

Baseline. Prisma 8 replaces v7 baselining with `db sign`, which "checks the
tables against your contract and then writes the marker" [S37]. `db migrate`
refuses a signed database until a migration in the history ends at the signed
state [S36].

Failure and concurrency. On PostgreSQL "a failed run leaves no changes in the
database at all"; MongoDB does not get that because "a run there is not one
transaction" [S38]. On PostgreSQL two concurrent `db migrate` runs wait for each
other [S38].

Retry of edited data migrations. A migration that only changes data starts and
ends at the same contract state. To retry an edited data migration "restore a
copy of the database from before it ran" [S35].

## Flyway (13.12.1)

Baseline. Covered in [S1]. Flyway has baseline migrations (`B` prefix) for new
environments and `baselineOnMigrate` for adopting an existing database [S1].

History table. `flyway_schema_history` has `installed_rank`, `version`,
`description`, `type`, `script`, `checksum`, `installed_on`, `installed_by`,
`execution_time` and `success` [S51].

Checksums and validate. Flyway stores a CRC32 checksum for SQL migrations when
they run [S40]. `validate` fails on different names, types or checksums, on
applied versions that no longer resolve locally, and on resolved versions not
yet applied [S40]. `validateOnMigrate` defaults to true [S43]. The checksum is
"encoding and line-ending independent" [S50].

Repair. `repair` removes failed migration rows, realigns checksums, descriptions
and types with local files, and marks missing migrations as deleted [S41].
`CHECKSUM_MISMATCH` is fixed by reverting the file or running `repair` [S49].

States. `info` prints every migration with its state [S42]. States include
Pending, Success, Ignored, Deleted, Baseline, Below Baseline, Missing, Failed,
Future, Out of Order, Outdated and Superseded [S54]. `info` filters by date,
version and state [S42].

Out of order. `outOfOrder` (default false) applies a lower version found after
higher ones were applied [S44]. Such rows get the Out of Order state, and the
docs warn "Rerunning the entire migration history might produce different
results!" [S54].

Failure. Flyway wraps each migration in a transaction, halts on failure and does
not process further migrations [S53]. On databases without transactional DDL it
marks the migration failed, and "You may also need to run repair to remove the
failed migration entry" [S53]. `group = true` wraps all pending migrations in
one transaction [S53]. The CLI returns a non-zero exit code on failure, `1` by
default [S48].

Concurrency. Flyway takes a lock at the start of a migration and retries every
second up to `lockRetryCount`, default 50 [S45].

Repeatable migrations. `R__` migrations have no version. They are "(re-)applied
to a database on migrate every time their checksum changes" and "always applied
last, after all pending versioned migrations have been executed", in description
order [S52]. Flyway leaves idempotency to the author [S52]. Typical uses are
views and procedures and "Bulk reference data reinserts" [S68]. With placeholder
replacement on, the checksum of a repeatable migration is computed after
placeholders are replaced, so a changed placeholder value triggers a re-run
[S50]. Putting `${flyway:timestamp}` in the script makes it run on every
`migrate` [S52].

Callbacks. Events include `beforeMigrate`, `beforeEachMigrate`,
`afterEachMigrate`, `afterEachMigrateError`, `afterVersioned`,
`beforeRepeatables`, `afterMigrate` ("After Migrate command succeeds"),
`afterMigrateApplied` (only when at least one migration ran) and
`afterMigrateError` [S46].

Placeholders. `${key}` values come from configuration. Built-ins include
`${flyway:environment}`, `${flyway:database}`, `${flyway:filename}` and
`${flyway:timestamp}` [S47].

Conditional execution. Flyway expects the same migrations in every environment.
Exceptions use per-environment locations, cherry-picking or the Enterprise
`shouldExecute` script setting [S55].

## Liquibase (5.0.4)

Identity. A changeset "is uniquely tagged by both the author and id attributes
(author:id), as well as the changelog file path" [S63]. Once run, it does not
run again "unless you specify runAlways or runOnChange" [S63].

History table. `DATABASECHANGELOG` has `ID`, `AUTHOR`, `FILENAME`,
`DATEEXECUTED`, `ORDEREXECUTED`, `EXECTYPE`, `MD5SUM`, `DESCRIPTION`,
`COMMENTS`, `TAG`, `LIQUIBASE`, `CONTEXTS`, `LABELS` and `DEPLOYMENT_ID` [S58].
Exec types are `EXECUTED`, `FAILED`, `SKIPPED`, `RERAN` and `MARK_RAN` [S56].

Checksums. The checksum is computed per changeset, not per file, and stored in
`MD5SUM`. A mismatch halts Liquibase [S65]. Fixes are nulling the stored
checksum in every environment, adding `<validCheckSum>` with the old or new
value, or `clear-checksums` [S65]. `validCheckSum` "Adds a checksum that is
considered valid for this changeset, regardless of what is stored in the
database"; `1:any` matches all [S62].

Re-run attributes. `runAlways` "Executes the changeset on every run, even if it
has already been run". `runOnChange` "Executes the changeset when you create it
and each time it changes". Both default to false [S62]. `ignore` treats a
changeset as if it does not exist, and `runOrder` can be `first` or `last`
[S62].

Contexts and labels. Contexts and labels on changesets are matched against
filters to decide which changesets run in a given run [S62]. `changelog-sync`
accepts a context filter and a label filter, according to a search summary of
the 5.1 command page [S61].

Preconditions. `onFail` values: `HALT` (default) stops the changelog, `CONTINUE`
skips and retries next update, `MARK_RAN` "Skips over the changeset but marks it
as executed", `WARN` continues [S57][S64]. `sqlCheck` runs SQL that must return
one value equal to `expectedResult` [S64]. Changelog-level preconditions are
evaluated before any changeset runs, and only changeset-level preconditions
accept `CONTINUE` and `MARK_RAN` [S64]. Failures return a non-zero exit code
[S64].

Mark as run. `changelog-sync` "marks all undeployed changes in your changelog as
executed", and the docs name baselining a new environment as its typical use
[S61]. `changelog-sync-to-tag` and `mark-next-changeset-ran` narrow the scope
[S59].

Transactions. Each changeset runs as one transaction by default; with
`runInTransaction` false, a partial failure leaves `DATABASECHANGELOG` "in an
invalid state" [S62][S63]. `failOnError` defaults to true [S62].

Locking. `DATABASECHANGELOGLOCK` holds a lock row. `waitForLock` polls every 10
seconds for up to 5 minutes by default, then throws "Could not acquire change
log lock. Currently locked by ..." [S59][S60]. A process that dies leaves the
lock set; `release-locks` clears it and `list-locks` shows host, IP and
timestamp [S59].

Observability. `status` lists pending changesets, `history` lists deployed
changesets with their deployment ID, and `validate` checks the changelog [S59].

Testing. `update-testing-rollback` updates, rolls back the same changesets, then
updates again [S59].

## Ecto (ecto_sql 3.14.0)

History and status. `schema_migrations` has `version` and `inserted_at` [S71].
`mix ecto.migrations` shows up/down status, and recorded versions with no file
show as `** FILE NOT FOUND **` [S72].

Logging. The real flags are `--log-migrations-sql` (SQL generated by migration
commands) and `--log-migrator-sql` (SQL of the migrator itself, such as
transactions and locks) [S73]. I found no `--log-migrations` flag.
`--strict-version-order` aborts on a migration with an older timestamp;
otherwise Ecto warns [S73].

Concurrency. By default Ecto locks the migration table, wrapping the migration
and the version insert in one transaction [S69][S70].
`migration_lock: :pg_advisory_lock` allows concurrent index builds; when the
lock is busy Ecto retries every 5 seconds without limit by default, and fails
only when configured retries run out [S69]. A migration can opt out with
`@disable_migration_lock true` [S70].

Data migration guidance. The ecto_sql guides include "Backfilling Data" and
"Safe Ecto Migrations", written by David Bernheisel and first published on
Fly.io [S74][S76]. Key rules:

- Do not reference application schemas in migrations, because "the code and
  schema may change over time". Use raw table queries or a small schema defined
  inside the migration [S74].
- Four keys: run outside a transaction, batch, throttle, and be resilient. Use
  `@disable_ddl_transaction true` and `@disable_migration_lock true` [S74].
- Use keyset pagination, because `LIMIT`/`OFFSET` slows down and cursors need a
  transaction [S74].
- "Every time the data migration is re-run, it should pick up where it left off
  without revisiting already-migrated records" [S74].
- Store data migrations in a separate path and run them manually, for example
  `mix ecto.migrate --migrations-path priv/repo/data_migrations` or a release
  function [S74].
- Deterministic data: if the query condition no longer matches after the update
  (for example `IS NULL`), re-query until empty [S74]. Arbitrary data: if
  updated rows look like un-updated rows, first copy the target IDs into a real
  tracking table, so progress survives a crash [S74].
- The guide notes that teams who run data migrations often may want a separate
  system "that is observable, hooks into error reporting, metrics, and allows
  for dry runs" [S74].

Squash. The squashing guide dumps the structure with `mix ecto.dump`, loads it
on empty databases, and then runs newer migrations; old files can then be
deleted [S75].

## Laravel (framework 13.40.0)

History table. `migrations` has `id`, `migration` and `batch` [S79].

Schema dump. `schema:dump --prune` writes a schema file and deletes old
migrations [S1][S66]. On PostgreSQL the dump appends the data rows of the
`migrations` table to the schema file, so a loaded database already knows which
migrations ran [S80].

Status and dry run. `migrate:status` shows run and pending migrations;
`migrate --pretend` prints SQL without running it [S66].

Concurrency. `migrate --isolated` takes an atomic lock through the cache driver.
Other runs "will not execute; however, the command will still exit with a
successful exit status code" [S66]. The base command returns the
`isolatedExitCode` (success) or a numeric value passed to `--isolated` [S78].

Exit codes. `migrate --graceful` returns "a successful exit code even if an
error occurs" [S77].

Seeds. Seeders live in `database/seeders` and run through `db:seed` or
`migrate:fresh --seed`. In production `db:seed` asks for confirmation unless
`--force` is given [S67].

## Atlas (1.3.0)

Integrity file. `atlas.sum` holds one hash per migration file plus a directory
sum. The per-file hash is cumulative: the hasher is not reset between files, so
each file's hash covers all earlier files [S87]. Adding a migration changes the
sum file, "which will raise merge conflicts in most version control systems",
and so stops two branches from adding migrations in parallel without notice
[S81]. `migrate validate` recomputes the sum and reports a mismatch [S86][S87].

Baseline. On a database with no revisions that is not clean, Atlas refuses to
run unless `--baseline` or `--allow-dirty` is set [S82][S88]. `--baseline V`
writes a revision of type baseline for version V and treats only later files as
pending [S88]. `migrate set V` marks all migrations up to and including V as
applied; it is meant for after manual changes [S86].

Checkpoints. A checkpoint file (`-- atlas:checkpoint`) is the sum of all earlier
migrations. On a clean database Atlas starts from the last checkpoint and skips
earlier files [S83][S88]. `migrate checkpoint` is an Atlas Pro feature [S83].

Revision table and resume. Each revision records `Version`, `Description`,
`Type`, `Applied` and `Total` statement counts, `ExecutedAt`, `ExecutionTime`,
`Error`, `ErrorStmt`, file `Hash`, `PartialHashes` and `OperatorVersion` [S88].
In `--tx-mode none`, Atlas detects the failed statement and resumes from it on
the next attempt, so editing a file "from the failed statements onwards is safe"
[S82]. `--tx-mode file` (default) wraps each file in a transaction and `all`
wraps all pending files [S82][S86].

Ordering. `--exec-order` is `linear` (default, fail on out-of-order files),
`linear-skip` or `non-linear` [S82][S86].

Concurrency. A second `migrate apply` waits for the lock and fails after
`--lock-timeout`, default 10 seconds [S82].

Lint. `migrate lint` checks destructive changes, breaking changes, table locks
and custom policies, on the latest N files or against a git base [S84].

Testing. `atlas migrate test` runs HCL test cases that start from an empty
directory state: `migrate` to a version, `exec` SQL, `assert` a true single
value, `catch` an expected failure [S85]. For data migrations the docs say to
migrate to the version before, insert test data, migrate to the tested version,
then assert [S85]. It requires Atlas Pro (free or paid tier) [S85].

## sqitch (1.6.1)

Verify scripts. Each change can have deploy, revert and verify scripts.
`sqitch verify` checks that each change is deployed, present in the plan,
deployed in order, and "Passes its verify test" [S91]. Verify scripts check the
state after deploy and must exit non-zero on failure [S91]. A missing verify
script is a warning, not a failure [S91].

Deploy with verify. `deploy --verify` runs each verify script after deploy. A
verify failure counts as a deploy failure [S89]. `--mode all` (default) reverts
every change deployed in this run, `tag` reverts to the last tag, `change`
reverts only the failed change on verify failure [S89]. Sqitch assumes each
deploy script is atomic, so a failed deploy script has nothing to revert [S89].

Rework. `sqitch rework` changes a change that is already in production. It
requires a tag since the previous instance, and both versions must be idempotent
[S90]. Old scripts are copied to files named with the tag; only the latest
rework runs its verify script [S90][S91].

Drift. `sqitch check` compares SHA1 hashes of local deploy scripts with those
recorded at deploy time and reports divergence [S92].

Registry. `changes` stores the current state with `script_hash`, committer and
planner fields. `events` is append-only with `event` in `deploy`, `revert`,
`fail`, `merge` [S94].

Concurrency. On PostgreSQL Sqitch calls `pg_try_advisory_lock(75474063)`. If
busy it logs "Blocked by another instance of Sqitch", waits up to `lock_timeout`
(default 60 seconds), then fails [S93].

## golang-migrate (4.20.1)

State. The table has `version bigint` and `dirty boolean`. `SetVersion`
truncates the table and inserts one row, so there is no history, only the
current version [S96].

Dirty flag. Before each migration it sets `dirty = true`, runs the body, then
sets `dirty = false` [S95]. If the body fails, the row stays dirty. Every later
command fails with "Dirty database version N. Fix and force version." [S95]. The
operator must find out whether the migration ran partly or not at all, fix the
database, and run `migrate force VERSION` [S97][S98].

Concurrency. Some drivers lock: PostgreSQL uses `pg_advisory_lock`, MySQL uses
`GET_LOCK` [S96][S98].

## Comparison

| System            | Fresh baseline                            | Waits / exit code            | Failure, resume, lock                                | Verification                                       | Derived-data re-run                   | Pruning                           | History record                      |
| ----------------- | ----------------------------------------- | ---------------------------- | ---------------------------------------------------- | -------------------------------------------------- | ------------------------------------- | --------------------------------- | ----------------------------------- |
| Rails             | schema load marks older versions run [S4] | foreground, raises [S3]      | per-migration txn; try-lock, fail fast [S3][S7]      | none                                               | none (`reset_counters` separate [S1]) | `NO FILE` [S3]                    | version only [S6]                   |
| maintenance_tasks | n/a; seeds in `seeds.rb` [S8]             | enqueue only [S9]            | cursor resume, pause, cancel, throttle [S8]          | none built in                                      | n/a, tasks should not repeat [S8]     | delete task code [S8]             | rich run row [S11]                  |
| data_migrate      | `data:schema:load` marks run [S15]        | foreground [S14]             | inherits Rails                                       | pending check [S14]                                | none                                  | inherits Rails                    | version only [S15]                  |
| Django            | squash + `--fake` [S16][S17]              | `--check` exits 1 [S16]      | per-migration txn; no lock [S16][S17]                | none                                               | none                                  | `--prune` [S16]                   | app, name, applied [S18]            |
| Prisma 7          | `resolve --applied` [S29]                 | `status` exits 1 [S25]       | failed blocks deploy; 10s lock [S24][S29]            | checksum warn [S24]                                | none                                  | squash [S1]                       | checksum, logs, steps [S33]         |
| Prisma 8 RC       | `db sign` checks then marks [S37]         | stops on check failure [S34] | one txn on Postgres; waits [S38]                     | pre/postcheck per op [S34][S35]                    | none                                  | n/a                               | marker hash [S38]                   |
| Flyway            | `B` migrations [S1]                       | non-zero exit [S48]          | failed row, `repair`; lock retry 50s [S41][S45][S53] | CRC32 `validate` [S40]                             | `R__` on checksum change [S52]        | Missing/Deleted states [S41][S54] | rank, checksum, success, time [S51] |
| Liquibase         | `changelog-sync` [S61]                    | non-zero exit [S64]          | lock table, 5 min wait [S59][S60]                    | MD5 per changeset, preconditions [S64][S65]        | `runOnChange`, `runAlways` [S62]      | not covered                       | exectype, deployment id [S58]       |
| Ecto              | `ecto.load` [S1][S75]                     | foreground [S73]             | table or advisory lock [S69]                         | none                                               | none                                  | `FILE NOT FOUND` [S72]            | version, inserted_at [S71]          |
| Laravel           | dump includes migrations rows [S80]       | `--isolated` exits 0 [S66]   | cache lock [S78]                                     | none                                               | none                                  | `--prune` deletes files [S1]      | migration, batch [S79]              |
| Atlas             | `--baseline`, checkpoints [S83][S88]      | stops on error [S82]         | statement-level resume; 10s lock [S82]               | cumulative `atlas.sum`, lint, test [S81][S84][S85] | none                                  | checkpoint [S83]                  | applied/total, error stmt [S88]     |
| sqitch            | n/a                                       | stops, reverts [S89]         | revert modes; 60s lock [S89][S93]                    | verify scripts [S91]                               | `rework` [S90]                        | n/a                               | append-only events [S94]            |
| golang-migrate    | `force` [S97]                             | stops [S95]                  | dirty flag, manual force [S95][S97]                  | none                                               | none                                  | n/a                               | one row [S96]                       |

## Best ideas for a Convex migration component

Ranked by fit to the problems in `docs/research/problem-statement.md` and to
Convex's constraints: no DDL, about 4096 documents and 1 second per mutation,
schema validated against all documents on push, rolling deploys with old
clients, component tables isolated, and triggers not run by `convex import`.

1. **An explicit baseline that records migrations as done without running them,
   guarded by a check.** Every system here has this
   [S4][S15][S16][S29][S37][S61][S88]. Atlas refuses a non-clean database
   without `--baseline` [S88], and Prisma 8 checks the tables before it writes
   the marker [S37]. Convex has no schema dump, so the guard must be data-level.
   Two safe forms follow: allow `baseline()` only when the migration's target
   tables are empty, or run each migration's needs-work check (idea 2) and mark
   it done only if nothing matches. This fixes requirement 1 (fresh deployments
   replay 98 entries) and requirement 3 (fresh deployments need a migration just
   to set flags).

2. **Each migration declares a needs-work check next to its run step.** Prisma
   8's `dataTransform` takes `check` and `run`, compiles to precheck, execute
   and postcheck, and skips the step when the postcheck passes [S34][S35].
   Ecto's "deterministic data" pattern re-queries the unmigrated condition until
   empty [S74]. sqitch verifies after deploy [S91], and Liquibase uses
   `sqlCheck` with `MARK_RAN` [S64]. In Convex the check is an indexed query
   that returns documents still needing work. It serves four uses: a resumable
   batch source that needs no stored cursor, a verifier before marking done, the
   guard for idea 1, and a test assertion. Each batch is one mutation, so the
   4096-document limit sets the page size, not the migration size. For changes
   where migrated and unmigrated documents look the same, Ecto's tracking-table
   pattern is the fallback [S74]; in Convex that is a cursor stored in the
   component.

3. **A series runner that waits and fails loudly.** Rails, Django, Flyway,
   Liquibase and Atlas run in the foreground, and Django `--check` and Prisma
   `status` exit 1 on pending or failed work [S16][S25][S48][S64]. Laravel's
   `--isolated` and `--graceful` both exit 0 on non-success, and
   `maintenance_tasks perform` only enqueues [S9][S66][S77]. Those are the
   behaviors to avoid. For Convex this means a runner action that drives every
   pending migration batch by batch, returns a non-zero result on failure, and
   stays under the action time limit by handing off to a continuation. A
   separate `status --check` style query should fail when anything is pending or
   failed, for CI and setup scripts. This fixes requirement 2.

4. **Derived-data rebuilds as a separate, version-keyed runner.** Flyway
   repeatable migrations re-run when their checksum changes and run after all
   versioned migrations [S52]. Liquibase has `runOnChange` and `runAlways`
   [S62]. Flyway includes placeholder values in the repeatable checksum, so an
   input change also triggers a re-run [S50]. Convex cannot hash function source
   at runtime, so the rebuild should carry an explicit version string. It
   re-runs when that version differs from the recorded one, or on an explicit
   `rebuild` call after `convex import`. Rebuilds run after migrations, as
   Flyway orders them [S52]. This fixes requirement 4: imported component status
   cannot suppress a forced rebuild.

5. **Sticky failure with explicit resolve, and resume from the last committed
   batch.** golang-migrate's dirty flag, Flyway's failed row and Prisma's
   blocked deploy all stop later work until an operator acts [S29][S53][S95].
   Their recovery is manual because SQL DDL can half-apply [S29][S53][S97]. A
   Convex batch is one transaction, so state after a failure is exact: the
   cursor or check marks where to resume. The component should keep the
   migration `failed` with error, batch and cursor, block later migrations in
   the same series, and offer `retry` (resume after a code fix), `markDone`
   (Prisma `resolve --applied` [S29]) and `reset` (re-run from scratch). Atlas's
   per-statement resume is the closest model [S82]. This also covers upstream
   issue #5 (first-batch failure not saved).

6. **A single runner lease with expiry, where a second caller waits on the same
   run.** Lock behavior here ranges from fail fast (Rails [S3]) through short
   timeouts (Prisma 10 seconds, Atlas 10 seconds, sqitch 60 seconds
   [S24][S82][S93]) to Liquibase's 5-minute wait and lock rows left behind by
   dead processes [S59][S60]. Convex mutations are serializable, so a lease row
   in the component table is enough. Give it a heartbeat and expiry to avoid
   Liquibase's stale-lock problem. A second `runAll` should attach to the active
   run and wait for its result, so a duplicate deploy step neither fails nor
   reports false success.

7. **Rich, append-only run history.** The best history rows record checksum,
   success, duration and installer (Flyway [S51]), deployment ID and exec type
   including `MARK_RAN` (Liquibase [S58]), logs and step counts (Prisma [S33]),
   or statement progress and the failing statement (Atlas [S88]).
   `maintenance_tasks` adds tick counts, arguments, metadata and backtraces
   [S11]. sqitch keeps an append-only events table [S94]. The component should
   store the current state per migration and an event log: started, batch,
   failed, baselined, marked done, reset, rebuilt. Each event records how it
   happened (ran, baselined, marked). That makes baselines and manual resolves
   auditable, which `--fake` in Django does not [S21].

8. **Pruning by name, with a visible "recorded but not registered" state.**
   Rails shows `NO FILE`, Ecto `FILE NOT FOUND`, Flyway `Missing`, and Django
   `--prune` removes stale rows [S3][S16][S54][S72]. Django also enforces a
   two-release squash rule through `replaces` [S17][S20]. The component should
   report status rows whose migration is no longer in code and offer a prune
   command. Removing a migration from code should be a normal step once every
   deployment reports it done, as `maintenance_tasks` suggests for task code
   [S8]. This fixes requirement 6.

9. **Seeds outside the migration history.** Rails, `maintenance_tasks`, Laravel
   and Prisma 7 keep seeds separate from migrations [S1][S8][S32][S67].
   Liquibase contexts and labels exist for environment-specific changesets
   [S62], but that leaves dev-only data mixed into the same history. The
   component should not own seeds. It should document a separate idempotent seed
   function and let the baseline step run after it. This fixes requirement 5.

10. **Readiness as a query on migration state.** None of the SQL tools gives
    readers a runtime readiness flag. The nearest are pending-migration errors
    at page load (Rails, `data_migrate` [S3][S14]) and GitLab's finalize step
    [S1]. With idea 1, a fresh deployment has every migration done, so a
    component query `isDone(name)` can replace the app-table flags without a
    flag-setting migration. Rolling deploys with old clients still need expand,
    migrate and contract in separate releases. Prisma's guide [S31] and Django's
    two-release squash [S20] use that shape.

11. **Throttle, pause and cancel between batches.** `maintenance_tasks` reloads
    status every second and supports `throttle_on` with backoff [S8]. Ecto
    sleeps between pages [S74]. In Convex, each batch mutation can read a pause
    or cancel flag, and the scheduler delay between batches is the throttle.

12. **Typed, validated arguments stored on the run.** `maintenance_tasks`
    validates attributes before enqueue and records them on the run [S8][S11].
    Convex validators (`v.*`) can do the same; this addresses upstream issue
    #30.

13. **Test helpers built around "migrate to before X, seed, run X, assert".**
    Atlas `migrate test` [S85], `maintenance_tasks` direct `process` tests [S8]
    and Liquibase `update-testing-rollback` [S59] show the useful shapes. With
    convex-test, the component should export a helper that runs one migration or
    the whole series to completion in-process, plus a helper that runs a
    migration's check as an assertion.

14. **Low priority: a drift guard on migration identity.** Flyway, Liquibase,
    Prisma and sqitch hash scripts to detect edits after apply
    [S24][S40][S65][S92]. Atlas's cumulative `atlas.sum` forces merge conflicts
    when two branches add migrations [S81][S87]. Convex migration code is
    TypeScript, and its source is not visible at runtime, so a hash would have
    to come from a build step or from an explicit version field. An
    author-declared version on each migration gives most of the value at low
    cost. A generated sum file is optional.

## Gaps

- I did not run any of these tools. Behavior comes from source and docs only.
- `maintenance_tasks` CLI exit code on enqueue failure is inferred from `cli.rb`
  (the `rescue` does not re-raise); I did not run it [S9].
- I found no validation in `maintenance_tasks` that prevents two active runs of
  the same task, only index code that expects it [S12]. A database constraint
  elsewhere could exist; I did not find one in the gem's migrations [S11].
- Exit codes for Rails `db:migrate`, Ecto `mix ecto.migrate` and Laravel
  `migrate` on a failed migration were not verified. The sources only show that
  they raise or stop [S3][S73].
- Prisma 8 is a release candidate [S39]. Its docs may change before release.
  Prisma 8 docs were read as `.md` exports of the live site on 2026-11-10.
- Flyway concept pages (repeatable, versioned, transactions, schema history,
  conditional execution) were read from the live Redgate site, not from a pinned
  copy [S52][S53][S54][S55]. Version labels were not shown on those pages.
- Liquibase docs were read across versions: attributes at Community 5.0.4 [S62],
  preconditions at Secure 5.0 [S64], `changelog-sync` at Secure 5.1, checksums
  at Community 5.0 [S65]. The source used is v5.0.4. The `changelog-sync` page
  fetch returned the description and uses [S61]. The context and label filter
  options in the Liquibase section come from a search result summary of the same
  page, not from my fetch.
- Atlas `migrate lint` exit behavior is not stated on the lint page [S84]. The
  checkpoint page does not say how checkpoints behave on databases that already
  have revisions; the Atlas source shows only the clean-database path and a
  partially applied checkpoint path [S88].
- Atlas declarative data management and the seed-data FAQ appeared only in
  search summaries and are not cited.
- Django has no built-in data migration test helper that I found; only the
  `MIGRATE` test setting [S23].
- Liquibase `status` output columns and Flyway `info` JSON fields were not
  examined in detail.

## Sources

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
