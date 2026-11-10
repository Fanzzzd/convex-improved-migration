# 10. Developer experience contract

Date: 2026-11-10

## Status

Accepted. Partly implemented in 0.1.0; see below. Revised on 2026-11-10 by ADR
12 (clean-slate API).

## Context

Good DX is a requirement for this component. The motivating app
(`docs/research/problem-statement.md`) shows where upstream DX hurts today: a
hundred-entry list repeated by hand, a CLI call that says nothing about the rest
of the series, failures that exit 0, status that needs
`--component migrations lib:getStatus '{"limit":1000}'`, TS2589 type cycles
(upstream #28), and a separate verifier and archive procedure written per
migration. GitLab prints the exact command that fixes a failed migration.
Terraform-style previews and Flyway `info` show what will run before it runs.

## Decision

The public surface follows these rules.

1. One call. `defineMigrations(component, { schema })` returns `m`, typed from
   the app schema with no generic parameter. `m.plan([...])` returns the
   `migrations` object, which holds everything else.
2. Write a Step once. Steps are data with an explicit id (ADR 12); there is no
   per-Step export and no `internal.*` list. The one export line,
   `export const { apply, status, operate, runStep } = migrations.functions`,
   never changes.
3. No type cycles. Step definitions never reference `internal`; every function
   `m.plan` returns has a fixed type.
4. Typed ids. `migrations.isReady(ctx, id)`, `migrations.start`,
   `migrations.step`, and the TypeScript argument types of the registered
   functions accept only the Plan's Step ids. `markDone` also accepts a recorded
   Orphan id.
5. One way to run work, with short CLI calls. The CLI is
   `npx convex-improved-migration <command>`: `apply`, `apply --dry-run`,
   `apply --only <id>`, `apply --no-wait`, `rebuild --all`, `status`,
   `status --events <id>`, `check`, `mark-done <id> --reason <text>`,
   `reset <id>`, `cancel`, `adopt --expect-count <n>`. Without the CLI,
   `npx convex run migrations:apply` and the other registered functions still
   work.
6. Dry run is a preview. It writes nothing and returns, per Step, whether it
   would run and why ("never ran", "version 1 -> 2", "rebuild requested", "done
   via ran on 2026-11-03T09:00:00.000Z"). For each table Step that would run it
   also returns the writes of the next Batch, to any table, up to 20 changes. A
   removed field shows as `"<unset>"`. A value over 2,000 JSON characters is
   cut.
7. Errors say what to do next: Step id, Kind, Batch number, processed count,
   Batch size, error text, Steps not run, and the exact next commands (`apply`
   to resume, `reset <id>`, `mark-done <id> --reason`).
8. Readable results: `apply` and `status` return compact per-Step summaries, not
   raw rows. `status` also returns `next`, the commands that make sense now.
9. Testing: the `/test` export registers the component for convex-test with
   `register(t, "migration")`; `await t.action(internal.migrations.apply, {})`
   runs the Plan in-process; `expectNoneNeed(t, id)` asserts the `needs` count
   is zero. Step bodies are plain functions, and
   `migrations.step(id).definition.run` reaches them from a unit test.
10. Safe defaults: no implicit skipping (ADR 2), Apply fails loudly (ADR 3), an
    unfinished Orphan blocks Apply (ADR 7). An argument that a call does not
    read is an error, in `operate` and in the CLI. `operate` throws for `cancel`
    with an id and for `reset` or `cancel` with a reason.

What the dry run previews for a table Step:

- A Step that never ran, or was reset: the first Batch.
- A Step that failed or was canceled part way: the Batch at the saved Cursor.
- A Rebuild that starts over: its `clear` from the start, then the first Batch,
  in one transaction that is rolled back. With a table name as `clear`, the
  preview clears one page of that table. The dry run decides "starts over" with
  the same rule as Apply and `status` (ADR 4), so a failed or canceled Rebuild
  that is due for a cause previews its `clear` too.
- A Step with only its verify pass left: no writes.

Known limits of the dry run in 0.1.0:

- A dry run is one function call. Past the foreground budget (ADR 3) it stops
  previewing Batches and says so for the Steps that are left. Preview one of
  those with `--only`.
- Under convex-test, a `clear` function that calls `.paginate()` cannot run in
  the same function as the Batch (ADR 4). The dry run then previews the Batch
  without the clear and says so.
- `dryRun` takes only `only`. With `rebuild`, `wait` or `resume` it throws, and
  the CLI refuses `rebuild --dry-run`.

CLI behaviour:

- Exit codes: 0 every Step is Done or the command succeeded, 1 a Step failed, a
  check failed or the server refused, 2 `--timeout` passed while the run
  continues, 64 usage error, 130 after SIGINT and 143 after SIGTERM.
- Every argument is used as typed or refused. Usage errors: an unknown command
  or option (names are case-sensitive, and `-h` is the only short option), an
  option the command does not read, a stray positional argument, an option given
  twice, an empty or blank option value, a value on a flag ("--prod takes no
  value."), an option token in place of a value, and any two of `--dry-run`,
  `--no-wait` and `--timeout` together. So `rebuild --all --dry-run` does not
  rebuild. To pass a value that starts with `--`, write it inline, as in
  `--reason=--prod`. Every token after `--` is a Step id, so an id that starts
  with "-" needs `--` before it: `reset -- -odd`.
- `--help` or `-h` anywhere, `help`, or no command prints the usage text on
  stdout and exits 0.
- Deployment options pass through to `convex run` unchanged: `--prod`,
  `--deployment`, `--preview-name`, `--deployment-name`, `--env-file`, `--url`
  and `--admin-key`.
- SIGINT and SIGTERM stop the CLI, not the run. While the CLI waits for a run,
  it says so and names `cancel` and `status`. The run continues while the
  deployment's backend runs. On an anonymous local deployment without
  `convex dev`, that backend is a process `convex run` started. The run moves
  only while that process lives, and it must be stopped before `convex dev` can
  start. The `--timeout`, signal and `--no-wait` messages say so.
- Outcome unknown. A `convex run` call that fails with no "Uncaught" in its
  output, or exits 0 with output the CLI cannot read, got no answer from the
  function. The CLI then reads `status`. It follows only the run its own call
  started. It reads `status` before the first call, and treats as its own a run
  that became live since then, or a run id that appeared on a Step since then. A
  run that was already live before its call is not its own: the CLI exits 1 and
  names that run. It keeps waiting while its own run is live. When that run is
  no longer live, it calls `apply` with `resume` to learn how the run ended. It
  also exits 1 when it cannot read `status`, when it finds no run of its own, or
  after more than three such calls in a row.
- `cancel` reads `status` first. With no run it sends nothing and prints "No run
  to cancel." Otherwise it passes the run id it saw, and refuses when a newer
  run holds the deployment. When its `status` read fails, it cancels without a
  run id and prints "Cancel sent."
- Hints carry the deployment flags as typed, with the admin key shown as
  `<key>`. A server message that names commands gets a line such as "Add --prod
  to each command above."
- A wrong `--module` is a final error, not retried, that says to pass `--module`
  with the file's path under `convex/` without `.ts`.
- Every `status` read the CLI acts on is tried up to 3 times when `convex run`
  fails without an answer from the function: `status`, `check`, the read before
  `cancel`, and the reads around a dropped `apply` call. A function error is
  final. The progress poll during a run is display only and gets one try.
- `check --json` prints the status JSON and exits 1 when a Step is not Done.
- The CLI retries `mark-done`, `reset`, `cancel` and `adopt` on a write
  conflict, 3 times, 1 s apart.
- `adopt --expect-count` takes a whole number in digits only.
- The CLI starts the Convex CLI script of the project's installed `convex`
  package with the current Node, with no shell. Elsewhere it falls back to
  `npx convex`. On Windows it needs the local `convex` package and refuses
  without it.

The test helper: `register` sets a global flag. The component then arms its
sentinel (ADR 6) with the longest delay `setTimeout` can hold, 2^31 - 1 ms.
convex-test schedules with `setTimeout`, where the four-year delay would fire at
once and print a warning. With the flag the sentinel stays pending in tests, as
on a deployment.

Not built in 0.1.0: error codes. Every error is a plain `Error` with text and
next commands. A caller that branches on the cause must match the text.

## Consequences

- The README can teach the whole component with one file and a handful of CLI
  calls.
- The export line and the `module` option (ADR 12) are the only wiring the app
  author must get right. Apply creates the `runStep` function handle on every
  call. When that fails, the error names the `module` option.
