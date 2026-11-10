# 4. Batch atomicity and failure model

Date: 2026-11-10

## Status

Accepted. Partly implemented in 0.1.0; see below.

## Context

Upstream main records failures inside `migrateOne` by catching around a
sub-transaction, but failures that abort the outer mutation (OCC retries used
up, the 1-second limit) save no error text (upstream #5, PR #57). SQL tools make
failure sticky until an operator acts (golang-migrate dirty flag, Flyway
`repair`, Prisma `resolve`). GitLab halves and splits a batch after a timeout.
job-iteration can repeat an iteration after a crash because its cursor is saved
separately from the work.

## Decision

- A Batch is one component mutation. It calls the app's `runStep` mutation
  through a function handle as a sub-transaction and writes the new Cursor and
  counts in the same transaction. Writes and Cursor commit together.
- The sub-transaction runs under limits below the platform's: 12 MiB read, 12
  MiB written, 24,000 documents read, 12,000 documents written and 3,000
  database queries. A Batch that runs out fails inside its own sub-transaction,
  so the component mutation can still record the error.
- Errors inside the Step function are caught in the Batch and recorded. Errors
  that abort the whole Batch reach the Driver, which records them in a separate
  mutation. The foreground `apply` action and the background action share that
  Driver loop.
- A Failed Step stops the Plan. Later Steps do not run.
- Limit errors (transaction size, time) halve the Batch size and retry, down to
  a floor of one document. A limit error at one document fails the Step. Only
  messages that start with the platform's limit texts count: "Too many ... in a
  single function execution" or "transaction", "Function execution timed out",
  "Transaction too large". A `ConvexError` thrown by a Step never counts. Other
  errors fail the Step at once. A Seed or `m.once` Step has no Batch to halve,
  so a limit error fails it. The same holds for a `clear` function, which is one
  call.
- After each successful Batch below the configured size, the size grows by 1.2x,
  up to the configured size. A smaller `batchSize` set in code since the last
  Batch wins over the saved size.
- A per-second write throttle rejects every write, and a smaller Batch does not
  lower bytes per second. The Driver waits (1 s, doubling to 16 s, at most 8
  times in a row) and retries the same Batch. It records the wait as a "write
  throttled" Event. A Batch that keeps losing write conflicts against other
  writes is retried the same way and recorded as a "write conflict" Event. A
  wait that ends in a handover or a recorded failure is recorded under `(run)`.
  After 8 retries in a row the Step fails and the run ends. The count carries
  across a handover, a background Driver hop, a watchdog restart and `resume`,
  on the Lease as `throttleRetries`. A unit of work that goes through resets it.
- Recovery is explicit: fix code and `apply` again (resumes from the Cursor),
  `reset <id>` (restart from an empty Cursor), or
  `mark-done <id> --reason <text>`. `reset`, `mark-done` and `cancel` call
  `operate`, an internal action. Each component mutation it calls is retried on
  a write conflict or a write throttle, six tries in all, so these commands work
  against a busy Driver. `reset` and `mark-done` refuse a Step that a live run
  is working on; run `cancel` first. `mark-done` also refuses a Step that is
  already Done, unless it is a Rebuild due for a version change or a rebuild
  request, and refuses every Rebuild while a snapshot import is suspected. Both
  refuse inside the transaction that writes. Both clear the Step's run id, so
  `status` names no run beside the new state.
- One rule, `startOver` in `src/shared.ts`, decides whether a Step resumes from
  its Cursor or starts over. Apply, the dry run and `status` all use it. A
  Rebuild with a Version change, a rebuild request or a suspected Snapshot
  Import starts over with its `clear`, also after a failure or a cancel.

Not built in 0.1.0:

- Growth from `getTransactionMetrics()` headroom. The fixed 1.2x step replaced
  it.
- A shape guard. The component does not record a Step's `table` or `range`. When
  either changes while a Cursor is saved, nothing detects it. `reset` the Step
  after such a change.

## Consequences

- Upstream #5 is closed by design: every failure has error text, Batch number,
  Batch size and processed count in `status`. The Cursor stays saved in the
  component.
- A Step's `run` must still be idempotent, because `reset` and Rebuilds
  re-process documents. `needs` (ADR 8) makes that cheap.
- Batch sizing is internal behaviour; the only knob is the starting size.
- `.paginate()` inside `run` or a `clear` function works on a deployed backend,
  beside the Batch's own paginated query. `e2e/e2e.sh` checks that on a local
  backend. convex-test allows one paginated query per function, so a `run` that
  paginates fails in tests. The error names the Step and says so. Prefer
  `.take()` or `.collect()` inside `run`.
- `e2e/e2e.sh` checks one outer abort on a local backend: a Batch that passes
  the 1-second user-code limit in a background run is recorded on the Step as
  Failed. No test covers exhausted OCC retries.
