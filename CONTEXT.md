# convex-improved-migration

Data migrations for Convex that a fresh deployment, a CI job and a restored
snapshot can all run safely. One bounded context: the component, its client SDK,
and the vocabulary they share.

Status: accepted. Implemented in 0.1.0.

## Language

**Plan**: The ordered list of Steps an app declares with `m.plan([...])`.
`m.plan` returns the `migrations` object: the four registered functions under
`functions` (`apply`, `status`, `operate`, `runStep`) and the helpers `isReady`,
`status`, `start`, `step` and `ids`. One Plan per component mount. Steps run in
list order. _Avoid_: queue, runner, series (upstream terms with different
behaviour)

**Step**: One entry of the Plan: a plain object built by `m.migrate`, `m.once`,
`m.seed` or `m.rebuild`, not an exported Convex function. Every Step has a Step
Id and a Kind.

**Kind**: What decides whether a Step runs on a given Apply. Exactly three:

- **Migration**: runs once per deployment, then stays Done. `m.migrate` scans a
  table Batch by Batch. `m.once` has no table and is a single mutation.
- **Seed**: runs on every Apply. Must be idempotent. One mutation.
- **Rebuild**: recomputes derived data. Runs when its Version differs from the
  recorded one, when an operator requests it with `apply({ rebuild })`, or when
  Apply detects a Snapshot Import. In each of these cases it starts over with
  its `clear`, also after a failure or a cancel. _Avoid_: task, job, change,
  backfill (a backfill is one use of a Migration or a Rebuild, not a kind)

**Step Id**: The required string a Step is declared with
(`"2026-11-10-user-role"`), unique in the Plan. The key in the component's
state. Moving or renaming code never changes it. CLI arguments call it `id`.
_Avoid_: name, key, function name

**Version**: An author-chosen string or number on a Rebuild. Changing it means
"the derived data must be recomputed".

**Batch**: One component mutation that runs one page of a Migration or Rebuild
by calling `runStep` as a sub-transaction, and records the new Cursor in the
same transaction. A Batch either commits its writes and its Cursor together or
neither.

**runStep**: One of the four registered functions `m.plan` returns and the app
exports. Only the component calls it, through a function handle, with the Step
Id and an operation: `batch`, `verify`, `clear` or `run`. It dispatches to that
Step's definition.

**Needs**: The optional `needs(doc)` predicate on a table Migration: true while
a document still needs work. Batches skip documents where it is false; the
verify pass counts documents where it is still true.

**Cursor**: The saved position of a Step inside its table. Resuming a Step
continues from the last committed Cursor. Cancel keeps the Cursor; `reset`
clears it.

**Apply**: The blocking entry point. An action that runs every Step that needs
to run, in Plan order, waits for all of them, and throws on the first failure,
so `npx convex-improved-migration apply` and `npx convex run migrations:apply`
exit non-zero. Past its foreground budget (`foregroundBudgetMs`, default 4
minutes) it hands the rest to a background Driver and throws Still Running.
_Avoid_: runAll, migrate, deploy

**Start**: The non-blocking entry point. `apply({ wait: false })`, the CLI's
`apply --no-wait`, and `migrations.start(ctx)` from app code schedule the same
work in the background and return at once.

**Dry Run**: `apply({ dryRun: true })`. Writes nothing. Returns, per Step,
whether it would run and why, plus up to 20 writes of the next Batch of each
table Step that would run. A Step with a saved Cursor is previewed from that
Cursor. A Rebuild that starts over is previewed with its `clear` from the start,
in one transaction that is rolled back. The dry run, Apply and `status` use one
rule to decide whether a Step resumes or starts over. An unfinished Orphan makes
the dry run refuse with Apply's error. _Avoid_: preview mode, plan (Plan is the
Step list)

**Still Running**: The error Apply throws when it handed unfinished work to the
background. It names the run id, and the run's `only` when it has one. CI must
treat it as "not done". Resume keeps waiting for the same run, and the CLI does
that by itself. A plain Apply instead takes the work over as a new run, which
runs the Seeds once more.

**Resume**: `apply({ resume: runId })`. Takes the Lease back for the run that
threw Still Running and goes on under the same run id, so Seeds do not run
again. It must pass the run's `only`; another scope is refused, also after the
run ended. When the run is already over, it reports how the run ended from the
Run record: done, failed, canceled, stalled, or taken over by another run.

**Run record**: One row in the component's `runs` table per run that takes the
Lease. It holds the run's `only` and, once the run ends, its outcome: done,
failed with the failure, canceled, stalled, or taken over by another run. The
first outcome stays, so a later `reset` or `mark-done` does not change what
Resume reports. Run records are never cleaned up.

**Driver**: The action loop that runs Batches one after another. A foreground
Apply is a Driver. So is the background action that Start and a handover
schedule. A background Driver action works for `budgetMs` (default 20 minutes),
then schedules the next one. A watchdog mutation starts a new background Driver
when the old one's action was lost.

**Lease**: The single row that says which Driver may run Batches right now. A
new Apply replaces it, and the previous Driver stops at its next Batch. A Driver
renews it at most every 15 seconds. It also stores the run's `only` and the
throttle retries in a row, which carry across Driver hops. It expires two
minutes after the last renewal; `status` then reports the run as not live. A
failed release leaves it to expire. _Avoid_: lock, mutex

**Cancel**: `operate({ op: "cancel" })`, or `cancel` in the CLI. `operate` is an
internal action that retries its writes, so Cancel works against a busy Driver.
Stops the run at the next Batch boundary. With a `runId` it stops only that run
and leaves a newer run alone; the CLI passes the run id its `status` read saw.
Without one it stops whatever run holds the Lease. The running Step returns to
pending and keeps its Cursor, so the next Apply resumes it. No Step state
records a cancel; `status` shows the Step as pending with the reason "canceled;
apply resumes it". Cancel logs a "canceled" Event per Step and one under
`(run)`, and records the outcome in the Run record. Apply, Resume and a handover
then report the run as Canceled. When no Driver is left to stop, Cancel deletes
the Lease.

**Done**: The terminal success state of a Step on one deployment. Always
recorded with **Via**, how it became Done:

- `ran`: the Step completed on this deployment.
- `marked`: an operator ran `mark-done` with a reason.
- `adopted`: copied from `@convex-dev/migrations` status by Adoption. A Step is
  never Done because the deployment "looks fresh". _Avoid_: complete, finished,
  applied, success

**Failed**: A Step whose last Batch threw, or whose verify pass found documents
that still need work. The error, the Cursor and the Batch size are recorded. A
Failed Step stops the Plan: later Steps do not run until it is fixed and
re-applied, reset, or marked Done.

**Stalled**: A Step recorded as running while no live Lease belongs to its run.
`status` derives it; the component never stores it. Apply resumes a Stalled Step
from its Cursor, unless it is a Rebuild that is due to start over.

**Readiness**: The answer to `migrations.isReady(ctx, id)`, read by app queries
and mutations to choose between the new and the legacy code path during
expand/contract. Replaces app-table readiness flags. _Avoid_: flag, feature
flag, migrationFlags

**Verified**: A table Migration with a Needs predicate whose final scan found no
document that still needs work. Verification runs before the Step is recorded
Done. _Avoid_: validated (Convex schema validation is a different thing)

**Adoption**: The one-time copy of Done records from an app's existing
`@convex-dev/migrations` component, guarded by an expected count. _Avoid_:
import (reserved for `npx convex import`), migrate

**Snapshot Import**: `npx convex import` of a ZIP export. It restores this
component's tables too, so recorded Rebuilds look Done. The component suspects
an import when its sentinel, a scheduled function that snapshots do not carry,
is gone. `status` then reports `importSuspected` and shows Done Rebuilds as
pending, `check` fails, and `isReady` is false for Rebuilds. The next Apply runs
every Rebuild again. Two cases are not detected: an import of single tables, and
an import back into the same deployment when no Apply ran there after the
snapshot was taken.

**Orphan**: A Step Id recorded in the component but absent from the current
Plan. A Done Orphan is a pruned Step and is harmless. An unfinished Orphan means
a Step was pruned before it finished on this deployment; Apply and the Dry Run
refuse to run.

**Event**: One append-only record of something that happened to a Step: started,
resumed, done (with Via), failed, batch shrunk, write throttled, write conflict,
rebuild requested, reset, canceled. Run-level Events (handed over, taken back,
restarted, stalled, canceled, and waits that ended in a handover or a recorded
failure) are stored under the pseudo id `(run)`. Status shows current state;
Events show history.
