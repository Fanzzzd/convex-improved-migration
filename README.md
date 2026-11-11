# convex-improved-migration

A Convex component that runs data migrations, seeds and rebuilds from one
ordered Plan. One command runs the Plan, waits for it to finish, and exits
non-zero when a Step fails, so a deploy or setup script can stop on it.

```sh
npx convex-improved-migration apply
```

Status: version 0.x. The API can still change. Design decisions are in
`docs/adr/`.

## Install

```sh
npm install convex-improved-migration
```

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import migration from "convex-improved-migration/convex.config.js";

const app = defineApp();
app.use(migration, { name: "migration" });
export default app;
```

## Write a Plan

The Plan lives in `convex/migrations.ts`. Steps run in the listed order.

```ts
import { defineMigrations } from "convex-improved-migration";
import { components } from "./_generated/api";
import schema from "./schema";

const m = defineMigrations(components.migration, { schema });

export const migrations = m.plan([
  // Seed: runs on every apply. Write it as an idempotent upsert.
  m.seed("countries", async (ctx) => {
    /* insert missing rows */
  }),

  // Migration over a table: runs once per deployment, one Batch per
  // transaction. `needs` skips documents that are already migrated and
  // drives a verify pass over the table before the Step is Done.
  m.migrate("2026-11-10-user-role", {
    table: "users",
    needs: (u) => u.role === undefined,
    run: () => ({ role: "member" }),
  }),

  // Migration without a table: one mutation, once per deployment.
  m.once("2026-11-10-grant-admin-export", async (ctx) => {
    /* insert the grant if it is missing */
  }),

  // Rebuild: clears and recomputes derived data when `version` changes,
  // on request, or after a snapshot import.
  m.rebuild("request-counters", {
    version: 1,
    table: "requests",
    clear: "requestCounters",
    run: async (ctx, r) => {
      /* add r to its user's counter */
    },
  }),
]);

// The four registered functions. This line never changes.
export const { apply, status, operate, runStep } = migrations.functions;
```

Step ids are permanent. Do not rename or reuse one. A Step removed from the Plan
before it finished on a deployment blocks `apply` there until you put it back or
record it with `mark-done`. The dry run refuses with the same error.

A table Step's `run(ctx, doc)` gets one document and returns the fields to
patch, or writes through `ctx`. It must be idempotent, because `reset` and
Rebuilds process documents again. Options per table Step: `range` (an index
range to scan), `batchSize` (default 100) and `parallelize`.

`defineMigrations` options: `module` (the file that exports the functions,
default `"migrations"`), `internalMutation` (a custom builder, for example one
wrapped with triggers), `defaultBatchSize`, `budgetMs` (how long one background
driver action works, default 20 minutes) and `foregroundBudgetMs` (how long one
`apply` call works, default 4 minutes, see below).

## Run it

```sh
npx convex-improved-migration apply            # add --prod for production
```

`apply` runs every Step that needs to run and prints progress. Deployment flags
(`--prod`, `--deployment`, `--preview-name`, `--deployment-name`, `--env-file`,
`--url`, `--admin-key`) pass through to `npx convex run`. The CLI runs the
project's own `convex` package, with no shell in between. On Windows it needs
`convex` installed in the project and refuses otherwise.

| Command                                      | Effect                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `apply [--only <id>] [--timeout <duration>]` | Run the Plan and wait for the end.                                                                                    |
| `apply --no-wait`                            | Start a background run and return.                                                                                    |
| `apply --dry-run`                            | List the Steps that would run. For table Steps, also up to 20 writes of the next Batch, to any table. Writes nothing. |
| `rebuild --all` or `rebuild <id>...`         | Mark Rebuilds pending, then run like `apply`.                                                                         |
| `status [--events <id>]`                     | Print the state of every Step, and the Event history of one.                                                          |
| `check`                                      | Exit 1 unless every Step is Done. For a gate before a deploy.                                                         |
| `mark-done <id> --reason <text>`             | Record a Step as Done without running it.                                                                             |
| `reset <id>`                                 | Clear a Step's progress so the next apply runs it from the start.                                                     |
| `cancel`                                     | Stop the run at the next Batch boundary. The Step keeps its cursor.                                                   |
| `adopt --expect-count <n>`                   | Copy Done records from `@convex-dev/migrations`.                                                                      |

Common options: `--module <path>`, `--json` and `--help`. The CLI uses every
argument as typed or refuses it with a usage error. An option that a command
does not read is refused, so `rebuild --all --dry-run` does not rebuild. A flag
with a value is refused, so `--prod=false` does not target production. An option
in place of a value is refused: write `--reason=--prod` to mean that text. A
Step id that starts with `-` goes after `--`, as in `reset -- -old`. `rebuild`
takes `--all` or ids, not both. `--timeout` must be more than 0; leave it out to
wait until the run ends. The commands that messages suggest come without your
deployment flags. The CLI adds them to its own suggestions and, for the
server's, prints "Add --prod to each command above", with the admin key shown as
`<key>`. With a wrong `--module` the CLI says to pass the file that holds the
Plan.

Exit codes: 0 when every Step is Done or the command succeeded. 1 when a Step
failed, a check failed, or the server refused. 2 when `--timeout` passed and the
run continues. 64 for a usage error, which includes an empty option value such
as `--reason ""`. 130 and 143 after SIGINT and SIGTERM. `check --json` prints
the status as JSON and exits 1 unless every Step is Done.

How `apply` behaves:

- On failure it names the Step, the Batch, the cause and the next commands. The
  cursor is saved, so the next `apply` resumes after the fix.
- A failed Step stops the Plan. Later Steps stay pending.
- A Rebuild starts over, with its `clear`, when its version changed, a rebuild
  was requested, or a snapshot import is suspected. That holds also when it
  failed or was canceled part way, so its saved cursor is dropped. `status` and
  the dry run say so, for example "version 1 -> 2; apply starts it over", and a
  failed Rebuild stays failed in `status` until then. `apply`, the dry run and
  `status` decide this with one shared rule. Every other Step that failed or was
  canceled resumes from its saved cursor.
- `npx convex run` drops a call after 300 s (measured on a local backend: exit 1
  after 302 s). So one `apply` call works for at most 4 minutes
  (`foregroundBudgetMs`), then moves the run to a background driver and throws
  "Still running" with the run id. The CLI calls `apply` again with `resume`,
  which goes on with the same run: the run id stays and Seeds do not run again.
  A long backfill is therefore not limited by the call limit or by the action
  time limit.
- If an `apply` call ends without an answer from the function, for example on a
  dropped connection, the CLI reads `status` to find the run that call started:
  a live run that was not live before the call, or a run id that no Step showed
  before. It keeps waiting for that run, or asks the server how it ended. A run
  that was already working before the call is not its own: the CLI exits 1 and
  names that run. The same holds when the output of a finished call cannot be
  read. The CLI tries every `status` read it acts on up to 3 times, 2 s apart,
  when `convex run` gets no answer. This includes `status`, `check` and the read
  before `cancel`.
- Ctrl-C or SIGTERM stops the CLI, not the run. The CLI says so and names
  `cancel`.
- A waiting `apply` also works on a local deployment with no `convex dev`
  running. There `npx convex run` starts the local backend process, and the run
  moves only while that process lives. Ctrl-C in the terminal stops it with the
  CLI. After `--timeout`, or a signal sent to the CLI alone, it keeps running
  and holds the port, so stop it before you start `npx convex dev`. The CLI
  prints this note on a local deployment. `--no-wait` does not help there: the
  background run moves on only while a later command keeps the backend up. The
  CLI says so after `--no-wait` on a local deployment.
- A second `apply` on the same deployment takes over from the first. The first
  one stops at its next Batch and reports the takeover. A `cancel` is reported
  as "Canceled", also when it lands while `apply` hands the run to the
  background or records a failed Batch.
- `reset` and `mark-done` refuse a Step that a live run is working on. Run
  `cancel` first. `mark-done` also refuses a Step that is already Done, unless
  it is a Rebuild that `apply` would start over for a version change or a
  rebuild request. While a snapshot import is suspected it refuses every
  Rebuild, because the next `apply` rebuilds them all. These checks happen in
  the transaction that writes, so a run that finishes the Step at that moment
  keeps its record. After `reset`, `mark-done` or `adopt` the Step shows no run
  id, because no run changed it.
- After `cancel`, `status` shows the interrupted Step as "canceled; apply
  resumes it", also when the cancel came during its clear. `apply` with `resume`
  on a canceled run fails with "Canceled".
- `cancel` reads `status` first and cancels the run it saw, by run id. If a
  newer run took over by the time the cancel lands, it changes nothing, names
  the newer run and exits 1. With no run it sends nothing and prints "No run to
  cancel". If it cannot read `status`, it cancels whatever run is there and
  prints "Cancel sent". Called directly, `operate({ op: "cancel" })` also stops
  whatever run is there; pass `runId` to stop only that run.

What `--dry-run` previews for a table Step:

- A Step that never ran, or was reset: the first Batch.
- A Step that failed or was canceled part way: the Batch at the saved cursor,
  unless it is a Rebuild that starts over.
- A Rebuild that starts over (a done Rebuild that is due, or any Rebuild with a
  version change, a rebuild request or a suspected import): its `clear`, then
  the first Batch, in one transaction that is rolled back. With a table name as
  `clear`, the preview clears one page of that table.
- A Step with only its verify pass left: no writes.
- A dry run is one function call. Past the foreground budget (4 minutes by
  default) it stops previewing Batches and says so for the Steps that are left.
  Preview one of those with `--only`.

Without the CLI, the same functions work through `npx convex run`:

```sh
npx convex run migrations:apply
npx convex run migrations:status '{"check":true}'
npx convex run migrations:operate '{"op":"reset","id":"2026-11-10-user-role"}'
```

Here `apply` throws "Still running: run <id> ..." after 4 minutes, because
`npx convex run` drops a call that takes longer than 300 s. The run continues in
the background. Keep waiting for the same run with:

```sh
npx convex run migrations:apply '{"resume":"<id>"}'
```

Pass the same `only` the run started with, if any. A `resume` with another
`only` is refused, and the error names the run's scope, also after the run
ended. Each run keeps a record of its scope and of how it ended, and `resume`
reports from that record: done, the failure that stopped it, canceled, taken
over by another run, or stalled. A later `reset` or `mark-done` does not change
that answer. A run id that this deployment has no record of is refused. A plain
`apply` also works. It takes the work over as a new run, which runs the Seeds
once more.

## Gate code on a Step

`migrations.isReady` reads component state inside a query or mutation, so code
can switch to the new shape only after the Step finished on this deployment:

```ts
import { v } from "convex/values";
import { query } from "./_generated/server";
import { migrations } from "./migrations";

export const roleOf = query({
  args: { id: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get("users", args.id);
    if (!user) return null;
    if (await migrations.isReady(ctx, "2026-11-10-user-role"))
      return user.role!;
    return user.role ?? "member";
  },
});
```

`isReady` is true when the Step is Done. For a Rebuild it is also false while a
rebuild is pending, while the recorded data was built for another `version`, and
while a snapshot import is suspected (see below). A Seed stays ready after its
first success. The row it reads changes only when the Step changes state, so a
gated query does not re-run on every Batch.

App code can also call `migrations.status(ctx)` and
`migrations.start(ctx, { only?, rebuild? })`, which schedules a background run
from a mutation or action. Call `start` only from an internal function or after
your own auth check, because it starts work on the whole deployment. The
`status` result can contain error text from your Steps, so check who is asking
before a public query returns it. A subscribed query that returns
`migrations.status(ctx)` re-runs when component state changes, not when time
passes. So a run whose driver died can show as running until the watchdog or the
next command touches it. A one-off read is exact.

One Plan per component mount. A second Plan on the same mount sees the first
Plan's unfinished Steps as removed and refuses to run. For a second Plan, mount
the component again under another name.

## Batches, limits and failures

- Each Batch is one transaction: the documents' writes and the new cursor commit
  together.
- A Batch runs with limits below the Convex transaction limits. A Batch that
  hits a limit is rolled back, the batch size halves, and the run continues. The
  size grows back by at most 1.2x per Batch. A document that still fails at
  batch size 1 fails the Step.
- An error thrown by your `run` fails the Step at once and is not retried with
  smaller Batches.
- When the deployment throttles writes per second, the driver waits (1 s,
  doubling to 16 s) and retries the same Batch. After 8 retries in a row the run
  fails. The count goes on across a handover to the next driver, a watchdog
  restart and a `resume`, and a Batch that goes through resets it. Each wait is
  recorded as a "write throttled" Event. A Batch that keeps conflicting with
  other writes is retried the same way and recorded as a "write conflict" Event.
  Waits that end in a handover or a recorded failure are recorded on the run
  ("(run)"). The short calls that take, hand over and release the Lease also
  retry a throttle or a conflict, up to 6 times. A failed release does not
  replace the outcome of the run; the Lease then expires after 2 minutes.
- When `needs` is set, a verify pass scans the table after the last Batch. If
  documents still need the Migration, for example because old code wrote the old
  shape during the backfill, the Step fails and names them. The next `apply`
  scans again.
- A background run is watched. If its driver action is lost, for example in a
  backend restart, a watchdog starts a new one within about two minutes. After
  three restarts in a row with no progress it stops and `status` shows the Step
  as stalled. A foreground lap that makes no progress does not reset that count.

Prefer `.take()` or `.collect()` over `.paginate()` inside `run`. Each Batch
already runs one paginated query, and convex-test allows one per function, so a
`run` that paginates fails in tests. The error names the Step and says so. A
deployed backend accepts it; `e2e/e2e.sh` checks that on a local backend. A
`clear` function runs in its own transaction and may paginate in both. In
convex-test a Dry Run then previews the Batch without the clear and says so.

## Snapshot imports

Derived data can be stale after `npx convex import`. The component detects that
its state came from a snapshot, and the next `apply` runs every Rebuild again.

- Into another deployment: always detected.
- Back into the same deployment: detected when an `apply` ran there after the
  snapshot was taken. If none did, run
  `npx convex-improved-migration rebuild --all` after the import.
- An import of single tables (`npx convex import --table`) does not replace the
  component's state and is not detected. Run `rebuild` for the Rebuilds that
  read those tables.

Until that `apply`, `status` reports `importSuspected: true` and shows every
Done Rebuild as pending, `check` exits 1, and `isReady` is false for Rebuilds.
Migrations and Seeds keep their state.

Detection uses a scheduled function that snapshots do not carry. Cancelling all
scheduled functions in the dashboard therefore reads as an import: Rebuilds show
as pending and the next `apply` runs each of them once more.

## Testing

```ts
// convex/migrations.test.ts
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import migrationTest, { expectNoneNeed } from "convex-improved-migration/test";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

test("the Plan applies", async () => {
  const t = convexTest(schema, modules);
  migrationTest.register(t, "migration");
  const result = await t.action(internal.migrations.apply, {});
  expect(result.ok).toBe(true);
  await expectNoneNeed(t, "2026-11-10-user-role");
});
```

Run it with Vitest in the `edge-runtime` environment, as the convex-test setup
guide describes.

`expectNoneNeed(t, id)` runs the verify pass `apply` runs, so it needs a Step
with a `needs` predicate and throws for any other Step. For a Plan in another
file, pass the module: `expectNoneNeed(t, id, { module: "plan" })`.

`register` also makes the component arm its import sentinel with a delay
`setTimeout` can hold, so tests print no TimeoutOverflowWarning. A test cannot
simulate a snapshot import, because app tests cannot reach the component's
scheduled functions. A foreground `apply` drives every Batch inside the action,
so a test needs no fake timers. `migrations.step(id).definition` exposes a
Step's options, including `run`, for unit tests. convex-test does not enforce
platform limits; `e2e/e2e.sh` covers those on a local backend.

## Moving from @convex-dev/migrations

An app that uses the upstream component usually has
`export const migrations = new Migrations(components.migrations)` in
`convex/migrations.ts`. Keep that file while you move. Put the Plan in another
file, for example `convex/plan.ts`, and pass `module: "plan"` to
`defineMigrations`, so the two exports named `migrations` do not clash. The CLI
then needs `--module plan`. Mount this component under another name than the
upstream one, as in Install above (`migration` beside `migrations`).

```ts
// convex/plan.ts
import { defineMigrations } from "convex-improved-migration";
import { components } from "./_generated/api";
import schema from "./schema";

const m = defineMigrations(components.migration, { schema, module: "plan" });

export const plan = m.plan([
  // An upstream migration that has not finished, ported under its name.
  m.migrate("migrations:backfillTotals", {
    table: "requests",
    run: (_ctx, r) => ({ amount: Math.round(r.amount) }),
  }),
]);

export const { apply, status, operate, runStep } = plan.functions;
export const adopt = m.adopt(components.migrations);
```

```sh
npx convex-improved-migration adopt --expect-count 12 --module plan
```

`adopt` records each finished upstream migration as Done here, with Via
"adopted", under its upstream name. It refuses and records nothing unless the
number of finished upstream migrations equals `--expect-count`, a whole number
in digits. It also refuses and records nothing while a live run is working on
one of those names. Run `cancel` first. A Step that failed here earlier loses
its error and its progress when it is adopted.

Adopted names are Done records with no Step in the Plan, so `status` lists them
under "Removed from the Plan". They do not block `apply`; only unfinished ones
would. An upstream migration that has not finished is not adopted. Port it as a
Step whose id is the upstream name, as `migrations:backfillTotals` above, and
`apply` runs it.

## Development

```sh
npm install
npm run build:clean
npm test            # convex-test unit tests
npm run typecheck
npm run lint          # oxlint
npm run format:check  # oxfmt; `npm run format` rewrites
cd e2e && ./e2e.sh    # local backend: limits, throttle, watchdog, CLI, snapshot import
```

The example app in `example/` has a page that starts runs and shows the Plan
live:

```sh
npm run dev           # pushes example/convex and watches the component
npm run dev:frontend  # serves the page
```

## License

Apache-2.0
