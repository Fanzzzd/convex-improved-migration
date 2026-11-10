# 6. Rebuilds survive Snapshot Import

Date: 2026-11-10

## Status

Accepted. Partly implemented in 0.1.0; see below. Revised on 2026-11-10 by ADR
12 (clean-slate API).

## Context

Triggers do not run on `npx convex import`. Derived tables (counters, search
postings, fact rows) must be rebuilt after an import. Convex export writes
component tables under `_components/<name>/` and import restores them, so
imported status says every rebuild is Done and upstream skips them. Flyway
repeatable migrations and Liquibase `runOnChange` re-run when their content
changes. Aggregate repairs by clearing and backfilling.

## Decision

- A Rebuild records the Version it last completed. Apply runs it when the
  recorded Version differs from the code's.
- `apply({ rebuild: "all" })` or `apply({ rebuild: [id] })` marks Rebuilds
  pending regardless of recorded state and then runs like any Apply (waits,
  throws). The CLI form is `rebuild --all` or `rebuild <id>...`.
- A Rebuild may declare `clear`, which runs before the backfill starts. An app
  table name makes the component empty that table in Batches. A function clears
  the derived data in one mutation. A `clear` that names the table the Rebuild
  reads throws when the Step is defined.
- While a Rebuild is pending or running, `isReady` returns false for it, so
  readers can fall back.
- A Rebuild that is due for a cause (a Version change, a rebuild request or a
  suspected import) starts over with its `clear`, also when it had failed or was
  canceled part way (ADR 4). `status` keeps a failed one failed, with the reason
  "<cause>; apply starts it over". A done one reads as pending, with the reason
  "<cause>; apply rebuilds it".
- The component suspects a Snapshot Import from a sentinel. The sentinel is a
  scheduled function armed four years ahead, and the component records its id.
  Every new run cancels the old sentinel and arms a new one. An import does not
  restore pending scheduled functions. So when the recorded sentinel is missing,
  canceled or failed, the state was restored. A sentinel that fired does not
  count.
- Apply acts on it. It marks every Rebuild pending, logs a "rebuild requested"
  Event with the detail "snapshot restore detected", and returns
  `restored: true`.
- Before that Apply, the same check runs read-only. `status` returns
  `importSuspected: true` and shows every Done Rebuild as pending, with the
  reason "snapshot import suspected; apply rebuilds it". `check` fails.
  `isReady` returns false for Rebuilds. Migrations and Seeds keep their state.

Known limits in 0.1.0:

- An import back into the same deployment is detected only when an Apply ran
  there after the snapshot was taken. That Apply canceled the sentinel the
  snapshot points at. When none ran, the sentinel is still pending and nothing
  is detected. Run `rebuild --all` after such an import.
- An import of single tables (`npx convex import --table`) does not replace the
  component's state and is never detected. Run `rebuild` for the Rebuilds that
  read those tables.
- Cancelling all scheduled functions in the dashboard reads as an import.
  Rebuilds show as pending and the next Apply runs each of them once more.

Not built in 0.1.0:

- Passes. A Rebuild scans one `table`. A Rebuild that scans several source
  tables in turn was proposed and deferred.
- A deployment stamp. Detecting an import by a stored deployment URL was
  proposed and deferred. The sentinel is the only detection.

## Consequences

- Rebuilding after an import needs no separate command in the detected cases:
  the next Apply does it. `rebuild --all` forces it at any time, independent of
  migration history.
- Bumping a Rebuild's Version in code is how to say "the derivation changed".
- No documented API reports a Snapshot Import. The sentinel depends on imports
  not restoring pending scheduled functions. `e2e/e2e.sh` checks that on a local
  backend, for an import into another deployment and back into the same one
  after another Apply there.
