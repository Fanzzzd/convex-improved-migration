# Research part: online and background migration systems

Appendix of `docs/research/industry-survey.md`. Citations `[On]` refer to the
Sources list at the end of this file.

Date: 2026-11-10. Slice of `docs/research/industry-survey.md`. Extends
`docs/research/baseline-prior-art.md` [O56]; it does not repeat that note's
GitLab basics, Stripe summary or LaunchDarkly overview.

Source pins: GitLab `v19.2.10-ee` unless a different tag is named.
maintenance_tasks `v2.17.0` (commit 6d6e4c0), job-iteration `v1.18.0` (a4e8b23),
gh-ost `v1.1.11` (2ed192c), Scientist `v1.6.5` (504a396), Vitess docs 24.0 from
`vitessio/website` at 996c536. Percona Toolkit pages show version 3.7.2.

## Short answer

- GitLab batched background migrations (BBM) are the closest model for a Convex
  component. Each migration is a persistent row with a state machine, a fixed
  upper bound, per-batch job rows and transition logs [O1][O2][O3][O4]. A
  separate finalize step either confirms the migration finished or runs the rest
  inline. Dependent code may not rely on the data until finalize has run [O1].
- GitLab marks a migration `finished` at enqueue time when the table is empty
  [O2]. A fresh database therefore never runs the backfill and still passes
  finalize [O2]. This is the only primary source found that defines
  fresh-deployment behaviour for a background migration.
- Every online tool separates "data copied" from "cut over". gh-ost waits on a
  flag file [O28], Vitess has `--postpone-completion` and `ready_to_complete`
  [O38], PlanetScale has gated deployments [O46]. A Convex component should have
  the same split: backfilled, then an explicit finalize.
- Verification is a first-class step in the mature tools: pt-table-checksum
  [O35], Vitess VDiff [O44], Stripe's re-run scan plus Scientist read comparison
  [O36][O37], Notion's sampled verifier written by a different engineer [O52].
  GitLab only states it as a best practice [O1]. Convex now ships staged
  validators, which verify a schema change against all documents in the
  background [O55].
- Throttling in SQL tools uses replication lag and server load [O27][O34].
  Convex exposes neither. What carries over is GitLab's time-efficiency batch
  sizer and split-on-timeout retry [O4][O6], and the per-iteration throttle hook
  from maintenance_tasks [O19].
- Convex mutations commit the cursor and the batch writes in one transaction.
  That is stronger than job-iteration, which persists the cursor separately and
  can repeat iterations [O19][O22]. Vitess VReplication has the same
  transactional property [O41].

## 1. GitLab batched background migrations in depth

### 1.1 Model and lifecycle

- A BBM is a subclass of `BatchedMigrationJob` with a `perform` method. A
  regular migration inserts a `batched_background_migrations` row; Sidekiq picks
  up active rows [O1, lines 52-59].
- Migration states in code: `paused` (initial), `active`, `finished`, `failed`,
  `finalizing`, `finalized` [O3, lines 88-118]. `finalize` moves any state to
  `finalizing`. `confirm_finalize` moves only `finished` or `finalized` to
  `finalized` [O3, lines 112-118].
- The docs define them: Active is ready or running; Finalizing is running jobs;
  Paused is "Not visible to the runner"; Finalized means verified with
  `ensure_batched_background_migration_is_finished` [O1, lines 1333-1343].
- Job states: `pending`, `running`, `failed`, `succeeded` [O4, lines 42-58].
  Every job transition writes a row to
  `batched_background_migration_job_transition_logs` with exception class and
  message [O4, lines 91-103].
- Migrations run in enqueue order. Two run in parallel by default (four on
  GitLab.com), never two on the same table [O1, lines 64-68].
- Jobs must be idempotent because Sidekiq can retry them [O1, lines 129-135].
  BBM code may not use application models, because new versions can deploy while
  a migration still runs [O1, lines 225-230].

### 1.2 Enqueue: `queue_batched_background_migration`

- Signature: job class, table, column, job arguments, plus `job_interval`,
  `batch_min_value`, `batch_max_value`, `batch_size`, `pause_ms`,
  `max_batch_size`, `sub_batch_size`, `gitlab_schema`, `min_cursor`,
  `max_cursor` [O2, lines 71-87].
- Defaults: `BATCH_SIZE = 1_000`, `SUB_BATCH_SIZE = 100`, minimum interval 2
  minutes, minimum pause 100 ms [O2, lines 18-24]. Shorter intervals are raised
  to 2 minutes [O2, lines 320-322].
- It is idempotent by configuration. If a migration with the same class, table,
  column and arguments exists, it logs a warning and returns [O2, lines 40-41,
  95-97, 307-318].
- It raises if the number of job arguments does not match what the job class
  declares [O1, lines 353-354].
- The upper bound is fixed at enqueue: `batch_max_value` defaults to
  `MAX(column)`, or `min_cursor`/`max_cursor` for cursor jobs [O2, lines 49,
  328-353]. The runner clamps every batch to that bound [O5, lines 128-142].
  Rows created later are the application's job: "Make sure the newly-created
  data is either migrated, or saved in both the old and new version upon
  creation" [O1, lines 356-358].
- Fresh-deployment rule: when no explicit bound is given and the table is empty,
  the new row's status event is `:finish`, otherwise `:execute` [O2, lines 329,
  346]. A fresh install records the migration as finished without running a
  batch.
- It also stores `total_tuple_count` from Postgres statistics, for progress
  reporting [O2, lines 273-283].
- Cursor-based iteration is the default for new jobs; the helper detects a
  `cursor` declaration and computes bounds [O1, lines 262-330].
- Enqueue runs in a post-deployment migration [O1, lines 337-340].
  Post-deployment migrations run separately from deploys, daily at the release
  manager's discretion on GitLab.com [O17, lines 49-52].

### 1.3 Execution, batch sizing and throttling

- `run_migration_job` creates the next job from the last job's bounds, performs
  it, then calls `adjust_migration`. If the job failed and `should_stop?` is
  true, the migration fails. With no next batch it finishes or fails [O5, lines
  32-42, 103-109, 144-152].
- `adjust_migration` evaluates database health signals. Any stop signal calls
  `hold!`; otherwise it calls `optimize!` [O5, lines 161-169]. `hold!` sets
  `on_hold_until`, 10 minutes by default [O3, lines 301-317]. The `executable`
  scope skips migrations on hold [O3, lines 41-42].
- Health signals in the docs: WAL archive queue, autovacuum on the target
  tables, Patroni Apdex below SLO, WAL rate [O1, lines 195-209].
- Optimizer: time efficiency is job duration divided by interval [O4, lines
  146-154]. The model takes an exponential moving average of the last 20
  successful jobs with alpha 0.4 [O3, lines 15-16, 258-276, 388-398].
- The optimizer targets efficiency 0.90 to 0.95. The multiplier is
  `min(0.95 / efficiency, 1.2)`. Batch size is clamped between 1,000 and
  2,000,000, or the migration's `max_batch_size` [O6, lines 17-64].
- The docs give a rough duration formula:
  `interval * number of records / max batch size` [O1, line 1049].

### 1.4 Retries and failure

- `MAX_ATTEMPTS = 3` per job [O4, line 18]. The `retriable` scope covers failed
  jobs under the attempt limit and "stuck" jobs not updated for 1 hour [O4,
  lines 23, 34-35].
- On a timeout error, after attempts run out, a job can split: batch size halves
  and the job splits at the midpoint [O4, lines 16, 156-181]. Sub-batch size can
  also shrink by 25% [O4, lines 21, 183-206].
- The migration fails when no jobs remain and some failed, or when more than
  half of the jobs since start failed, counted only after 50 jobs [O1, lines
  186-193][O3, lines 11-12, 208-218].
- `retry_failed_jobs!` splits and retries every failed job, then sets the
  migration active again [O3, lines 197-206].
- The docs warn that rescuing exceptions inside a job can mark it successful in
  a failure scenario [O1, lines 1486-1487].

### 1.5 Finalize and dependent-code rules

- "You cannot depend on any batched background migration being completed until
  after it is finalized" [O1, line 373].
- `ensure_batched_background_migration_is_finished` looks up the migration by
  class, table, column, arguments and schema. These must match the enqueue call
  exactly [O1, lines 381-393][O2, lines 196-217].
- Behaviour [O2, lines 228-262]:
  - Not found: warn and return, except in the database testing environment,
    where it raises.
  - Already `finalized`: return.
  - `finished`: call `confirm_finalize!`.
  - Otherwise, with `finalize: true` (the default), run the remaining work
    inline. If it is still not finished, raise an error that prints the exact
    rake command to finish it.
- The inline path (`BatchedMigrationRunner#finalize`) resets blocked jobs, moves
  the migration to `finalizing` so the background worker ignores it, performs
  pending jobs, then loops until the status changes. It raises
  `FailedToFinalize` if the migration is not finished [O5, lines 56-97].
- It refuses to run inside a transaction [O2, lines 206-210].
- Early-finalization guard: finalize raises unless the enqueue milestone is at
  or before the last required stop. `skip_early_finalization_validation: true`
  bypasses it [O2, lines 26-32, 234-236, 292-305][O1, lines 400-402].
- If the application does not need 100% of the data, the finalize step may be
  skipped [O1, lines 1736-1739].
- Declared dependencies: each migration file has a commented
  `DEPENDENT_BATCHED_BACKGROUND_MIGRATIONS` constant. A RuboCop cop
  (`Migration::UnfinishedDependencies`) fails if a listed BBM's dictionary file
  has no `finalized_by` value [O1, lines 1187-1236].
- Best practice: "If the data being migrated is critical and cannot be lost, the
  clean-up migration must also check the final state of the data before
  completing" [O1, lines 1480-1481]. This is a verifier, but the framework does
  not provide one.
- For schema-critical but slow changes, the style guide suggests guarding the
  feature with a feature flag, running a post-deployment migration, and turning
  the feature on after the migration finishes [O17, lines 45-46].
- Dropping a column takes three releases: ignore the column in the model (M),
  drop it (M+1), remove the ignore rule (M+2) [O18, lines 14-27].

### 1.6 `finalize_after`, required stops and the upgrade path

- In GitLab 17.3.2 the BBM dictionary YAML had `finalize_after: # yyyy-mm-dd`,
  described as "the (approximate) date after which the BBM is expected to be
  finalized". A cop required it [O14, lines 749-753][O15].
- At `v19.2.10-ee` the dictionary template has no `finalize_after`. It keeps
  `milestone`, `queued_migration_version` and `finalized_by` [O15a]. Timing now
  comes from required stops.
- Required stops land on X.2, X.5, X.8 and X.11 [O11, line 9]. Self-managed
  instances must upgrade through each stop.
- Finalization is scheduled "for the first minor version after the next required
  stop", so instances jumping between stops run the migration in the background
  first [O11, lines 15-25][O1, lines 375-380].
- A housekeeper keep (`Keeps::OverdueFinalizeBackgroundMigration`) finds BBMs
  from before the cutoff milestone, checks on a production-like database
  (Postgres.ai) that they finished, and opens an MR that adds the finalize
  migration [O13, lines 12-14, 32-34, 229-235, 264-266].

### 1.7 Requeue, stop and remove

- Requeue: no-op the original enqueue migration's `up` and `down`, then add a
  new post-deploy migration that calls `delete_batched_background_migration`
  first and then enqueues again [O1, lines 439-461]. The no-op prevents create,
  delete, create on instances that upgrade several patch releases at once [O1,
  lines 451-453].
- Stop and remove: no-op the enqueue migration, add a migration that deletes the
  BBM row, delete the job class, all in one MR [O1, lines 535-575].

### 1.8 Squash and code deletion

- Job code can be deleted after the next required stop following finalization
  [O1, lines 404-418].
- Squashing is automated since 18.9 and runs at each required stop. It squashes
  up to two stops back, for example up to 18.2 at the 18.8 stop [O12, lines
  10-38].
- `rake gitlab:db:squash[<ref>]` removes old migrations, rewrites
  `db/init_structure.sql`, removes specs and "Cleans up finalized batched
  background migrations" [O12, lines 42-54].

### 1.9 Operations: ChatOps, rake, UI

- ChatOps (GitLab team members only): `list`, `status MIGRATION_ID`, `pause`,
  `resume`, with `--database` and environment options [O1, lines 1272-1393].
  Pause and resume work only on `active` migrations [O1, lines 1368, 1393].
  Progress "may not be reported correctly if the migration employs a cursor"
  [O1, line 1331].
- Rake (`v19.2.10-ee` source): `gitlab:background_migrations:finalize[...]` per
  database and `gitlab:background_migrations:status` [O9, lines 7-67].
- Admin docs list newer rake tasks: `list`, `show`, `pause`, `resume`,
  `execute[<id>]` and `execute_all` [O10, lines 15-244]. `execute_all` runs
  unfinished migrations in ID order, "Continues processing remaining migrations
  even if some fail", and reports failures [O10, lines 189-244].
- An unfinished BBM blocks upgrades with "Expected batched background migration
  for the given configuration to be marked as 'finished'" [O10, lines 278-288].
  Failed BBMs "prevent further application upgrades" [O10, line 564]. Admins can
  retry from the UI, finalize by rake, or, with Support, mark a migration
  finished in the console [O10, lines 433-580].
- The kill switch is the `execute_batched_migrations_on_schedule` feature flag;
  disabling it can make upgrades fail [O1, lines 1395-1407].
- `finalize_command` builds the exact rake command for error messages [O3, lines
  360-365].

### 1.10 Testing

- Tests are required for the enqueue migration, the job, and any cleanup
  migration [O1, lines 1459-1466]. RSpec hooks migrate the database down and up,
  so the docs suggest `spy` doubles [O1, lines 1467-1473].
- Current matchers: `have_scheduled_batched_migration` (exactly one BBM row with
  the given configuration and attributes),
  `be_finalize_background_migration_of`, and
  `ensure_batched_background_migration_is_finished_for` [O7, lines 3-71].
- The generated enqueue spec wraps `reversible_migration` and asserts "not
  scheduled" before and "scheduled with these attributes" after [O8, lines
  9-24]. The generated job spec is empty [O8a].
- `be_scheduled_migration` belongs to the legacy Sidekiq background migrations.
  It checks `BackgroundMigrationWorker.jobs` [O16, lines 28-41]. It still exists
  in 17.3.2 and is gone in 19.2.10 [O7][O16].
- `run_entire_migration` runs a whole BBM inline and raises outside development
  and test [O5, lines 44-54].

## 2. Shopify maintenance_tasks and job-iteration (operational semantics)

- Scope: maintenance tasks are for data changes, not schema. They "should be
  ephemeral ... They should not repeat". Seeds belong in `db/seeds.rb` [O19,
  lines 44-56].
- Readiness warning: "If your application can't handle a half-completed
  migration, maintenance tasks are probably the wrong tool ... intentionally
  pausable and can be cancelled halfway" [O19, lines 58-60]. The gem has no
  finalize or dependency concept.
- States: new, enqueued, running, pausing, paused, interrupted, cancelling,
  cancelled, succeeded, errored [O19, lines 916-936]. Paused can resume.
  Cancelled cannot.
- Resume after deploy: a task "can safely be interrupted, re-enqueued and
  resumed without any intervention at the end of an iteration". By default a run
  is interrupted after 5 minutes [O19, lines 974-991].
- On Sidekiq TERM, job-iteration stops between iterations, saves the position,
  enqueues a new job and marks the task interrupted. If workers are killed after
  the 25-second timeout, "at least one iteration may run again" [O19, lines
  993-1008]. The shutdown hook saves the cursor and progress [O20, lines
  162-166].
- Stuck runs: if the queue cannot re-enqueue, a task can stay in `pausing` or
  `cancelling`. Cancelling again after 5 minutes forces it; "Force pause" keeps
  the position [O19, lines 1012-1024].
- Throttling: `throttle_on(backoff:) { condition }` interrupts and retries after
  backoff, default 30 seconds. Shopify's condition checks replication lag,
  threads and write availability [O19, lines 416-468]. It wraps job-iteration's
  `build_throttle_enumerator` [O20, lines 103-117][O25, lines 26-38].
- Batch size: records are fetched 100 at a time by default;
  `collection_batch_size` changes it [O19, lines 168-193]. `process` should
  finish under 25 seconds and must be idempotent [O19, lines 700-718].
- Observability: ActiveSupport events `enqueued`, `succeeded`, `cancelled`,
  `paused`, `errored` with run ID, timings and error details [O19, lines
  588-630]. Callbacks: `after_start`, `after_pause`, `after_interrupt`,
  `after_cancel`, `after_complete`, `after_error` [O19, lines 650-680].
- Testing: unit-test `process`, plus `collection` and `count` if complex [O19,
  lines 734-759].
- Running: web UI, `maintenance_tasks perform <Task>` CLI, or
  `MaintenanceTasks::Runner.run` [O19, lines 853-914].
- job-iteration cursor contract: `build_enumerator(cursor:)` starts with `nil`;
  the enumerator yields an object and a cursor; Iteration persists the cursor
  after `each_iteration` returns successfully [O24, lines 10-17]. On SIGTERM it
  finishes the current iteration, re-enqueues itself with the latest cursor, and
  resumes with `id > cursor` [O22, lines 7-22].
- A deterministic failure on item 61 means items 1-60 are done and item 61
  retries until retries run out. Backend retries, as opposed to Active Job
  retries, restart from the beginning [O22, lines 24-30]. `throw(:abort)` stops
  a job with work left [O22, lines 32-34].
- Cursors go through JSON, so non-JSON types need custom serialize/deserialize
  [O24, lines 108-116].
- Shopify caps `each_iteration` at 25 seconds and interrupts jobs at least every
  5 minutes. `max_job_runtime` can only be lowered per class [O23, lines
  80-109].

## 3. gh-ost and pt-online-schema-change

### 3.1 gh-ost

- Mechanism: create a ghost table, apply the `ALTER` to it, copy rows chunk by
  chunk, and apply ongoing changes read from the binary log. gh-ost acts as a
  replica and uses no triggers [O31, lines 18-61].
- Cut-over: an atomic two-connection `RENAME` guarded by a sentry table. On
  timeout or connection death it returns to the pre-cut-over state and can retry
  [O26, lines 3-13]. `--cut-over-lock-timeout-seconds` defaults to 3 [O28, lines
  149-151].
- Postponed cut-over: with `--postpone-cut-over-flag-file`, cut-over waits while
  the file exists. It proceeds when the file is deleted or on the
  `unpostpone`/`cut-over` command [O28, lines 345-349][O29, lines 44-45].
- Throttling: replication lag on control replicas (`--max-lag-millis`),
  `--max-load` status thresholds, `--throttle-query`, `--throttle-http` polled
  every 100 ms, flag files, and the `throttle` command [O27, lines 19-79]. Any
  one reason throttles and cannot be overridden [O27, lines 81-87]. When
  throttled, gh-ost stops row copy and binlog reads except heartbeat writes
  [O27, lines 5-11].
- Throttle duration is bounded by binlog retention, because gh-ost resumes from
  the same binlog position [O27, lines 98-104].
- Abort controls: `--critical-load` panics; it can hibernate or re-check instead
  [O28, lines 121-139]. `--panic-flag-file` terminates immediately [O28, lines
  327-329].
- Pacing: `--chunk-size` default 1,000, range 10 to 100,000 [O28, lines
  103-105]. `--nice-ratio` sleeps in proportion to copy time [O28, lines
  315-317].
- Interactive commands over a Unix socket or TCP: `status`, `sup`,
  `chunk-size=`, `dml-batch-size=`, `max-lag-millis=`, `max-load=`,
  `critical-load=`, `nice-ratio=`, `throttle`, `no-throttle`,
  `postpone-cut-over-flag-file=`, `unpostpone`, `panic`. `?` reads the current
  value [O29, lines 7-50].
- Hooks: executables named by event, run in sequence. A non-zero exit fails the
  migration. Events include on-startup, on-validated, on-rowcount-complete,
  on-row-copy-complete, on-begin-postponed, on-before-cut-over, on-success,
  on-failure, on-batch-copy-retry [O30, lines 18-52]. Hooks get progress, ETA,
  copied rows and lag in environment variables [O30, lines 58-80].
- Resume: `--checkpoint` writes state to `_<table>_ghk` every 300 seconds by
  default; `--resume` restarts from it if binlogs remain [O28, lines 94-101,
  371-374][O32, lines 3-9].
- Verification: `--test-on-replica` runs the whole migration on a replica, swaps
  and swaps back, and leaves both tables. GitHub checksums both with `md5sum`
  over ordered rows; for added or dropped columns they compare shared columns
  [O33, lines 12-40].

### 3.2 pt-online-schema-change and pt-table-checksum

- pt-osc copies into an altered empty table in chunks, uses triggers to keep it
  current, swaps with an atomic `RENAME TABLE`, then drops the old table. It
  refuses tables that already have triggers [O34].
- `--max-lag` (default 1 s) pauses the copy until all replicas are below it, and
  waits forever [O34]. `--chunk-time` (default 0.5 s) resizes chunks using a
  decaying moving average of rows per second [O34]. `--max-load` pauses;
  `--critical-load` aborts [O34].
- `--pause-file` pauses while the file exists [O34]. pt-osc has no postponed
  cut-over. `--no-swap-tables` copies everything and drops the new table, "a
  more realistic --dry-run" [O34].
- Plugin hooks run in this order: `init`, `before_create_new_table` through
  `after_copy_rows`, `before_swap_tables`, `after_swap_tables`,
  `before_drop_old_table`, `before_exit` and others [O34].
- `--history` writes job progress to a table; `--resume <id>` continues from the
  last completed chunk [O34].
- pt-table-checksum runs one `REPLACE..SELECT` checksum per chunk on the source.
  Statement-based replication re-executes it on replicas, and a query compares
  the results [O35]. Results live in `percona.checksums` [O35]. The exit status
  is non-zero when any chunk differs; `pt-table-sync` repairs differences [O35].
  It also supports `--resume` and `--chunk-time` [O35].

### 3.3 What translates to Convex (no DDL, document store)

My inference from the sources above:

- Shadow table plus atomic rename does not translate. Convex has no table
  rename. Copying to a new table means application code must switch reads, which
  is expand/contract at the app level [O48][O49].
- Binlog tailing has no user-facing equivalent here. The nearest analogue is
  dual write in mutations or triggers that wrap writes. The prior note records
  that triggers do not run on `convex import` [O56].
- Replication-lag throttling has no signal. Convex limits are per transaction
  [O54]. The usable signals are batch duration against the 1 s budget, documents
  read or written against the limits, and failures.
- What does translate: a postpone-completion gate, a pause or kill flag checked
  between batches, runtime-tunable batch size, lifecycle hooks, checkpoint and
  resume, and chunked checksums. In Convex a chunked checksum is a paginated
  query that hashes a projection of old and new data per page.

## 4. Stripe "Online migrations at scale"

- Four steps: dual write, change reads, change writes, remove old data [O36].
  Details beyond the prior note [O56, section C]:
- Backfill ran offline: database snapshots in Hadoop, a Scalding job listing IDs
  to copy, then a parallel fleet copying them [O36].
- Objects also copy lazily when updated [O36].
- Dual writes were ramped by percentage while watching metrics [O36].
- Verification: after the copy, they ran the Scalding job again to confirm no
  records were missing. They also used Scientist to read both stores and raise
  an error on mismatch. Only then did reads switch [O36].
- Write switching was done in small code changes, "never ... more than a few
  hundred lines of code at one time". Calls to the old property raised errors so
  leftover use would surface [O36].
- Removal: empty the old array on load, then run a final job to find and delete
  what remained [O36].
- The post does not mention feature flags for switching reads [O36].

## 5. GitHub Scientist as a verification mechanism

- `use` is the control (old path), `try` is the candidate (new path). `run`
  always returns the control value. Scientist decides whether to run the
  candidate, randomizes order, times both, compares, swallows candidate
  exceptions, and publishes the result [O37, lines 23-32].
- Controls: `compare` for custom equality, `ignore` for known mismatches,
  `run_if` and `enabled?` for gating and percentage ramp-up, `clean` for what
  gets published [O37, lines 93, 206-311].
- Limits: since the candidate may not run, Scientist "is only safe for wrapping
  methods that aren't changing data" [O37, lines 477-479]. The two blocks run
  one after the other, so data can change in between; the README suggests a
  control-versus-control experiment to measure that noise [O37, lines 483-485].
  It does not protect against candidate timeouts [O37, line 450].
- Recommended pattern: write to both systems, verify at read time with
  Scientist, and add reconciliation scripts [O37, line 481]. Keep dual writes
  "until well after" the read experiment is removed, for rollback [O37, line
  492].
- Tests: `raise_on_mismatches = true` turns mismatches into errors, for test
  suites only [O37, lines 393-405].

## 6. Vitess and PlanetScale

### 6.1 Vitess online DDL

- The `vitess` strategy runs `ALTER TABLE` through VReplication, which also
  powers resharding and materialized views [O42, lines 9, 60-67].
- VReplication persists copy state "transactionally with the transfer itself".
  After a primary failover, the new primary resumes the stream and the scheduler
  takes ownership. A stream more than 10 minutes stale fails the migration [O41,
  lines 22-28]. Vitess retries an interrupted migration exactly once [O42, line
  99].
- Postponed launch keeps a migration `queued` until
  `ALTER VITESS_MIGRATION ... LAUNCH`, optionally per shard [O38, lines 16-94].
- Postponed completion: with `--postpone-completion` the migration copies data
  and tracks changes, then stalls at cut-over until
  `ALTER VITESS_MIGRATION '<uuid>' COMPLETE` [O38, lines 117-124, 301-307].
  `COMPLETE` "serves as a hint"; it does not cut over synchronously if copying
  is not done [O38, lines 211-222]. Operators wait for `ready_to_complete = 1`
  [O38, line 329].
- `POSTPONE COMPLETE` is the counter-command: keep the shadow table current but
  never cut over [O39, line 338]. `FORCE_CUTOVER` "merely marks the migration
  for forced cut-over" and kills blocking queries at cut-over time [O39, lines
  389-397].
- `CANCEL` moves queued or ready migrations to `cancelled` and interrupts
  running ones [O39, lines 450-455]. `RETRY` re-runs a `failed` or `cancelled`
  migration "with exact same arguments"; options cannot change [O39, lines
  605-609]. `CLEANUP` removes artifacts [O39, line 687].
- Revert: `REVERT VITESS_MIGRATION '<uuid>'` is itself a tracked migration. It
  works within 24 hours, only for the last successful migration on a table, and
  keeps data written since completion [O40, lines 7-31]. VReplication records
  the final GTID position at cut-over and resumes a reverse stream from it [O40,
  lines 229-230]. Some reverts fail, for example after a widened int column
  receives a larger value [O40, lines 27-31].
- Throttling uses the tablet throttler, which is based on replication lag and
  disabled by default [O43, lines 213-217].
- VDiff: a row-by-row comparison of source and target that reports missing,
  extra and unmatched rows. Vitess recommends it before `SwitchTraffic` and
  `complete` [O44, lines 8-13]. `resume` continues from the last primary key
  processed, so it can run once after the copy and again before cut-over [O44,
  lines 41-50].
- MoveTables workflows have `mirrortraffic` (a percentage of traffic),
  `switchtraffic`, `reversetraffic`, `cancel` (only before any traffic
  switched), and `complete`, which removes artifacts [O45, lines 77-125].

### 6.2 PlanetScale

- Deploy requests show a schema diff against the base branch and run
  deployability and lint checks. Deploys go through a serial queue per branch
  [O46].
- Gated deployments: unchecking "Auto-apply changes" makes PlanetScale "hold off
  on the cutover" after table sync, until someone clicks "Apply changes" or runs
  `pscale deploy-request apply`. An open gated deploy holds the queue [O46].
- Revert: available for 30 minutes after deploy. Data written to the original
  schema in that window stays; data in newly added tables or columns is lost
  [O46].
- Expand, migrate, contract in six steps: expand the schema, write to both,
  backfill, read new, write only new, drop old [O48]. Large backfills should be
  spread over time with background jobs [O48]. Before switching reads "it is the
  last time you can confirm that the data migration and new schema are accurate"
  [O48].
- Column rename needs at least two deploy requests: add the column, dual write,
  backfill, optionally add `NOT NULL`, switch to the new column, drop the old
  one [O47]. A direct rename is unsafe because the app deploy "is not perfectly
  atomic and synchronized with the schema change" [O47].

## 7. Expand/contract and flag-gated migrations

- Danilo Sato (2014) defines parallel change as expand, migrate, contract. The
  migrate phase lasts "until all database access code has been updated". A
  feature flag "can be used to control which version of the interface is used".
  Skipping contract can leave you "in a worse state than you started" [O49].
- Sato gives no mechanism for knowing when all clients have moved [O49].
- LaunchDarkly's guide defines migration stages [O51]:
  - 2-stage: `off`, `complete`.
  - 4-stage: adds `shadow` and `live`.
  - 6-stage: `off`, `dualwrite`, `shadow`, `live`, `rampdown`, `complete`. Move
    past `dualwrite` "When the data in the new system is identical to the data
    in the old system". In `complete` "you can safely deprecate the old system".
  - Rollback means moving back a stage [O51].
- GitLab gates slow, critical changes with a feature flag that is turned on
  after the post-deploy migration finishes [O17, lines 45-46]. Its formal gate
  is finalize [O1].

## 8. Large backfills with concrete mechanisms

- Notion (2021): writes went to an audit log; a catch-up process applied them to
  the shards. A backfill took about three days on a 96-CPU `m5.24xlarge` [O52].
- Notion's backfill compared record versions and skipped stale writes, so
  backfill and catch-up converge in any order [O52].
- Notion verified with a script that checked randomly sampled UUID ranges, and
  with flag-gated dark reads that compared both stores and logged differences
  [O52]. Different engineers wrote the migration and the verification [O52]. A
  reverse audit log was ready for rollback [O52].
- Figma (2024): a shadow-reads framework sent live reads through the new sharded
  views to compare performance and correctness [O53]. Logical sharding rolled
  out by percentage behind feature flags and could roll back "within seconds"
  [O53]. They skipped large backfills because they "would have taken months"
  [O53].

## 9. Convex facts that bear on these patterns

- Per query or mutation: 4,096 index ranges read (calls to `db.get` and
  `db.query`), 32,000 documents scanned, 16,000 documents written, 16 MiB read
  and written, 1 s of user code. Actions run up to 30 minutes on the Convex
  runtime and 10 on Node. A mutation can schedule 1,000 functions [O54]. The
  problem statement's "about 4,096 reads or writes" is the index-range limit,
  not a document limit [O57][O54].
- The first push after a schema change validates all existing documents and
  fails if any do not match [O55].
- Staged validators: `.staged()` validates a stricter validator in the
  background while the current one stays enforced. `npx convex deploy --dry-run`
  reports `validating`, `validated` or `failed`. A write that passes the current
  validator but fails the staged one succeeds and marks validation failed. Only
  the first offending document is reported. Promotion reuses the completed scan.
  One staged validator per table [O55].

## Comparison

| Axis                      | GitLab BBM                                                                                          | maintenance_tasks                                   | gh-ost / pt-osc                                      | Vitess / PlanetScale                                     | Stripe / Scientist                      |
| ------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- | --------------------------------------- |
| Fresh-deployment baseline | Empty table finishes at enqueue [O2]; squash to `init_structure.sql` [O12]                          | Not covered; seeds go elsewhere [O19]               | Not applicable                                       | Not applicable                                           | Not covered                             |
| Waiting / series          | Finalize runs inline or raises [O2][O5]; `execute_all` runs in order, continues past failures [O10] | One task per run                                    | One table per process                                | Serial deploy queue [O46]; `ready_to_complete` [O38]     | Manual phases                           |
| Failure and resume        | 3 attempts, split on timeout, fail at >50% failed jobs [O3][O4]                                     | Paused or interrupted runs resume from cursor [O19] | Checkpoint and `--resume` [O28][O34]                 | Auto resume after failover; `RETRY` same args [O39][O41] | Not covered                             |
| Verification              | Best practice only [O1]                                                                             | None                                                | Replica test plus md5 [O33]; pt-table-checksum [O35] | VDiff, resumable [O44]                                   | Re-scan plus read comparison [O36][O37] |
| Readiness gating          | Finalize; declared deps and a cop [O1]                                                              | None; warns against half-done states [O19]          | Postpone cut-over flag [O28]                         | `--postpone-completion`, gated deploys [O38][O46]        | Phases, percentage ramp [O36]           |
| Throttling / sizing       | Time-efficiency optimizer, health holds [O5][O6]                                                    | `throttle_on`, batch 100 [O19]                      | Lag, load, query, HTTP, flag file [O27][O34]         | Lag-based tablet throttler [O43]                         | Not covered                             |
| Observability             | States, transition logs, progress, rake, ChatOps [O1][O4][O10]                                      | Events and callbacks [O19]                          | Status line, socket, hooks [O29][O30]                | `show vitess_migrations` [O38][O39]                      | Published results [O37]                 |
| Testability               | Matchers, inline run in tests [O5][O7]                                                              | Unit-test `process` [O19]                           | Test on replica [O33]                                | Not covered                                              | `raise_on_mismatches` [O37]             |
| Pruning                   | Delete after next stop; automated squash [O1][O12]                                                  | Tasks are ephemeral [O19]                           | Not applicable                                       | `CLEANUP` [O39]                                          | Final job deletes old data [O36]        |

## Best ideas for a Convex migration component (ranked)

1. **Finalize as the readiness gate, with inline completion.** Split each
   migration into `backfilled` (async batches done) and `finalized` (confirmed).
   Finalize confirms a finished migration or runs the remaining batches
   synchronously. On failure it exits non-zero and prints the command to fix it
   [O2][O5]. Dependent code declares which migrations it needs, and a check
   fails when a dependency is not finalized [O1]. Convex fit: the inline run
   must be an action, so it gets 30 minutes [O54]. Past that it must hand back
   to the scheduler and let the caller poll. This addresses problems 2 and 3
   [O57].
2. **Empty at enqueue means finished.** Capture the upper bound when the
   migration is registered and rely on dual writes for newer documents
   [O1][O2][O5]. If the table has no documents in range, record the migration as
   finished without running a batch [O2]. Convex fit: a fresh deployment passes
   every finalize without replaying history and needs no flag-flipping
   migration. This is the source-backed answer to the gap in the prior note
   [O56, section C]. Bounding by `_creationTime` or `_id` order at registration
   is my inference; I did not test it on Convex.
3. **Persistent state machine with batch records and failure policy.** Model
   states on GitLab: paused, active, finished, failed, finalizing, finalized
   [O3]. Keep a batch log with error text [O4]. Retry a failed batch a few
   times. When a batch fails on a limit error, halve it and retry [O4]. Fail the
   migration on a failure ratio [O3]. Convex fit: a mutation that exceeds limits
   rolls back as a whole, so the cursor never advances past a failed batch. The
   driver can record the error outside that transaction. This fixes the
   "first-batch failure not saved" class of bug the problem statement names
   (upstream #5) [O57].
4. **Adaptive batch sizing against Convex budgets, plus a throttle hook.** Adapt
   GitLab's optimizer [O6]: target a fraction of the 1 s user-code budget and of
   the read and write limits [O54], grow at most 1.2x per step, and shrink on
   errors. Add a per-migration `throttleOn` predicate with a backoff, as in
   maintenance_tasks [O19], and a global pause flag checked between batches, as
   gh-ost does with flag files [O27]. Convex has no replication-lag signal, so
   health means batch duration, limit headroom and error rate. That is my
   inference from [O54].
5. **Postponed completion for the contract step.** Allow a migration to stop at
   "ready to complete" until an explicit `complete` command [O28][O38][O46]. Use
   it to flip a reader to the new field or to delete old data. Convex fit:
   rolling deploys keep old clients running for a while [O57], so contract
   should be a deliberate, separate act, as in GitLab's three-release column
   drop [O18].
6. **Built-in verifier per migration.** Each migration can define `verify`, a
   paginated read that counts or checksums documents still in the old shape or
   out of sync. Finalize runs it before confirming. The pattern follows GitLab's
   critical-data rule [O1], pt-table-checksum chunks [O35], resumable VDiff
   [O44], Stripe's re-scan [O36] and Notion's sampled verifier [O52]. Convex
   fit: where the change is schema-shaped, point users to staged validators as
   the verifier [O55]. Read comparison in the style of Scientist belongs in app
   code during dual reads, not in the component, because it only suits read
   paths [O37].
7. **Series runner that waits and fails loudly.** Provide a CLI-callable
   function that runs every pending migration in order and reports per-migration
   results with a non-zero outcome on failure. GitLab's `execute_all` shows the
   shape, though it continues past failures [O10]. Convex fit: it must stay
   within the 30-minute action limit [O54] or resume from the stored state.
8. **Prune by watermark, not by hand.** Allow deleting migration code once a
   migration is finalized everywhere it must run. GitLab uses required stops and
   automated squash for this [O1][O11][O12], and a bot opens finalize MRs for
   overdue migrations [O13]. Convex fit: the component should record, per
   deployment, which names are finalized, and treat unknown pruned names on a
   fresh deployment as baseline. This addresses problems 1 and 6 [O57].
9. **Ops surface: status, pause, resume, cancel, retry with the same arguments,
   hooks.** Use GitLab and Vitess command sets as the checklist [O1][O39]. Retry
   must reuse the original arguments [O39]. Lifecycle events go to an `onStatus`
   or `onComplete` callback, as in maintenance_tasks and gh-ost [O19][O30].
   Report progress from processed count against an estimate. GitLab warns that
   cursor-based progress can be wrong [O1].
10. **Test helpers.** Provide a convex-test helper that runs a migration or
    series to completion inline, like GitLab's test-only `run_entire_migration`
    [O5], and assertions like `have_scheduled_batched_migration` [O7]. Recommend
    unit tests of the per-document function, as maintenance_tasks does [O19].
11. **Cursor and idempotency contract.** In job-iteration and maintenance_tasks,
    items can run more than once after a crash [O19][O22], so they require
    idempotent work. In Convex the cursor update and the batch writes commit
    together in one mutation, the same property VReplication relies on [O41].
    The component can therefore promise each batch commits at most once. Still
    require idempotent per-document logic, because reruns and `reset` re-process
    documents [O56].
12. **Lower priority: revert window.** Vitess and PlanetScale revert schema
    changes for 24 hours and 30 minutes respectively [O40][O46]. For data
    migrations, keeping old fields until contract (idea 5) gives the same safety
    without a reverse stream.

## Gaps

- `finalize_after` is in the 17.3.2 docs and template [O14][O15] but not in the
  19.2.10 template [O15a]. I did not find the MR that removed it.
- `be_scheduled_migration` is a legacy matcher [O16]. The BBM matcher is
  `have_scheduled_batched_migration` [O7].
- The BBM doc says the batch size adapts "based on the performance of the last
  20 jobs" [O1]. The optimizer's code comment says "add 10% to or decrease by
  20%" [O6]. The code does `min(0.95 / efficiency, 1.2)` with no fixed 20% cut
  [O6]. I report the code.
- The ChatOps command source is not public and was not read. ChatOps facts come
  from the docs only [O1].
- The `HealthStatus` indicator source was not read. Health signals come from the
  docs [O1].
- The Percona, Stripe, PlanetScale, Fowler, LaunchDarkly, Notion and Figma pages
  were read through a fetch tool that summarizes. Quotes were checked against
  its excerpts, not raw HTML.
- The Vitess audit-and-control page was read from the website repo. `THROTTLE`
  and `UNTHROTTLE` were not studied.
- The Facebook OSC note cited by gh-ost [O26] was not fetched. GitHub's and
  Slack's own posts on large backfills were not found or read.
- LaunchDarkly's migration metrics page (consistency rate, latency) was not
  fetched [O51].
- Convex staged validator behaviour comes from docs [O55]. I did not run it.
  Whether a component can read staged-validation status from a function is
  unknown.
- Ideas 2, 4 and 11 make Convex-specific claims inferred from limits [O54] and
  the prior note [O56]. They have not been tested on a deployment.

## Sources

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
