# 3. Apply waits and fails loudly

Date: 2026-11-10

## Status

Accepted. Partly implemented in 0.1.0; see below.

## Context

`npx convex run migrations:runAll` returns after the first Batch of the first
migration; the rest are scheduled one after another through
`scheduler.runAfter(0)`. A failed migration is returned as a value, so the CLI
exits 0 (`convex run` exits 1 only when the function throws). Setup scripts and
CI cannot wait for the series and do not see failures. `runToCompletion` waits
and throws but handles one migration. Every mature CLI surveyed runs in the
foreground and exits non-zero on failure; Laravel `--graceful` and
`maintenance_tasks perform` are the counter-examples.

Convex limits actions to 30 minutes (Convex runtime). The `npx convex run`
client gives up earlier: the README records exit 1 after 302 s on a local
backend. Convex's maintainers do not want deploys blocked on migrations
(upstream #14), so this must be a library entry point the caller opts into, not
a deploy hook.

## Decision

- `apply` is an internal action. It takes the Lease, then runs one unit of work
  at a time until every Step that needs to run is Done. A unit is a Batch, a
  clear or verify page, or one Seed or `m.once` call. It returns a per-Step
  summary on success and throws on the first failure, with the Step id, the
  error, and the commands to run next.
- `apply` drives Batches itself, so it does not poll. It sleeps only to back off
  from a write throttle or a write conflict (ADR 4).
- Two budgets. `foregroundBudgetMs` limits one `apply` call. Its default is 4
  minutes, or `budgetMs` when that is shorter, so the call ends before the
  `npx convex run` client drops it. `budgetMs` (default 20 minutes) limits one
  background Driver action.
- Past its foreground budget `apply` hands the remaining work to a background
  Driver and throws Still Running. The error names the run id and the call that
  keeps waiting: `npx convex run migrations:apply '{"resume":"<id>"}'`, with the
  run's `only` when it has one. CI treats Still Running as failure.
- `apply({ resume: runId })` takes the Lease back under the same run id and goes
  on with the same run. Seeds that ran in this run do not run again, and the
  Lease keeps the run's `restored` flag. The component logs a "taken back" Event
  under `(run)`. `resume` cannot be combined with `rebuild` or `wait: false`.
- Every run that takes the Lease gets a run record in the component's `runs`
  table. It holds the run's `only` and, once the run ends, its outcome: done,
  failed with the failure, canceled, stalled, or taken over by another run. The
  first outcome stays. `advance`, `recordAbort`, Cancel, the watchdog and
  `prepare` write it. Run records are never cleaned up, like Events.
- `resume` must pass the same `only` as the run. A `resume` with another scope
  is refused, also after the run ended, and a run id with no run record is
  refused. The error names the run's scope and the call to use.
- When the run is already over, `resume` reports how it ended from the run
  record. It returns the result when the run was done. It throws the same
  failure text when the run failed, and the same Canceled text when it was
  canceled. When another apply took over it says "Another apply (run X) took
  over run Y." It says when the watchdog gave up on the run. A later `reset` or
  `mark-done` does not change the answer. A run with no outcome and no Lease
  reads "ended before the Plan finished".
- A plain `apply` after Still Running is a takeover. It starts a new run with a
  new run id, continues from the saved Cursors, and runs the Seeds once more.
- The background Driver is one internal action that runs the same loop. At its
  budget it schedules itself again. Convex runs a scheduled action at most once,
  so a watchdog mutation checks the Driver's scheduled job every two minutes.
  When the job ended and the run still holds the Lease, the watchdog starts a
  new Driver. After three restarts in a row with no new unit of work it deletes
  the Lease, records the run as stalled, and `status` shows the Step as stalled.
  A foreground lap with no new unit of work does not reset that count.
- `apply({ wait: false })` schedules the same work as a background run and
  returns at once. `migrations.start(ctx, { only?, rebuild? })` does the same
  from an app mutation or action.
- One Lease row, with an expiry, names the current Driver. A second `apply`
  takes over instead of starting a duplicate run. The first Driver stops at its
  next Batch boundary, and a foreground caller gets a takeover error.
- A Driver renews the Lease at most every 15 seconds, and on the first unit
  after a handover or a watchdog restart. Every command reads the Lease, so a
  write on each Batch would make commands lose write conflicts against a busy
  Driver. The Lease expires two minutes after its last renewal.
- When `apply` or the background Driver takes, resumes, hands over or releases
  the Lease and hits a write throttle or a write conflict, it retries, six tries
  in all. A failed release does not replace the outcome of the run. The Lease
  then expires after two minutes. `operate` (`mark-done`, `reset`, `cancel`) is
  an internal action and retries its writes the same way (ADR 4).
- Cancel marks the Lease as canceled and logs a "canceled" Event under `(run)`.
  The Driver stops at its next Batch boundary and releases the Lease. When no
  Driver is left, Cancel deletes the Lease itself. That is the case when the
  Lease expired, or when the Driver job of a background run has ended. A
  foreground `apply`, a handover and a later `resume` all report the run as
  Canceled, using the Lease or the run record.
- Cancel can name the run it means: `operate({ op: "cancel", runId })`. When a
  newer run holds the Lease, it changes nothing and says that run started since.
  When that run already ended, it says "Run X already ended; nothing to cancel."
  Without `runId` it stops whatever run holds the Lease. The CLI passes the run
  id its `status` read saw (ADR 10).
- `status({ check: true })` is a query. It throws unless every Step is Done, for
  CI gates that do not want to run work.
- The CLI wraps these functions. `npx convex-improved-migration apply` holds one
  `apply` call at a time and polls `status` beside it for progress lines. When
  `apply` ends with Still Running, the CLI calls `apply` again with `resume`.
  ADR 10 lists its exit codes and its other behaviour.

Not built in 0.1.0:

- Attach. A second `apply` does not join the active run and wait for it. It
  takes over, and the first foreground caller throws.
- A Plan hash. The background Driver keeps the Plan entries it started with, and
  a push during a run does not stop it.

## Consequences

- `npx convex-improved-migration apply` is a correct setup and release step:
  exit 0 means every Step is Done. `npx convex run migrations:apply` gives the
  same result for a run that ends within the foreground budget. A longer run
  throws Still Running, and the caller keeps waiting with `resume`.
- Deploy stays non-blocking; teams choose `apply` (wait) or `apply --no-wait`.
- Neither the client's 300 s limit nor the action time limit bounds a long
  backfill. `apply` hands over at its budget and `resume` goes on with the same
  run.
- The backoff needs timers in actions. `e2e/e2e.sh` checks on a local backend
  that an action can wait on a timer.
- A subscribed query that returns `migrations.status(ctx)` re-runs when
  component state changes, not when time passes. A run whose Driver died can
  show as running until the watchdog or the next command touches the Lease. A
  one-off read is exact.
