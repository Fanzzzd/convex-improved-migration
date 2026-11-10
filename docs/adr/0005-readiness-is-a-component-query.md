# 5. Readiness is a component query

Date: 2026-11-10

## Status

Accepted. Implemented in 0.1.0. Revised on 2026-11-10 by ADR 12 (clean-slate
API).

## Context

Expand/contract trains gate new read paths on a readiness flag in an app table,
set by the last backfill. Readers degrade when the flag row is missing, so an
empty new deployment needs a migration just to flip flags it never needed.
GitLab gates dependent code on finalize; DynamoDB hides a new index until its
backfill ends; Zero hides a new column until its backfill ends. In each case
readiness comes from the migration system's own state.

## Decision

`migrations.isReady(ctx, id)` (on the object `m.plan` returns, ADR 12) is a
helper usable from app queries and mutations. `id` is typed as the Plan's Step
ids, and an id that is not in the Plan throws. It reads the component's state
for that Step and returns true when the Step is Done (any Via) and, for a
Rebuild, when the recorded Version equals the Plan's, no rebuild is pending and
no Snapshot Import is suspected (ADR 6). A Seed is ready after its first success
and stays ready while it runs again.

Readers write
`(await migrations.isReady(ctx, "2026-11-10-backfill-x")) ? newPath : legacyPath`.
The contract release deletes the branch.

## Consequences

- The app flag table and every `mark*Ready` Step go away.
- On a fresh deployment the gated Migration runs over empty tables during the
  first Apply and becomes Done. Before that, readers take the legacy path, which
  is correct because there is no legacy data.
- Readiness is reactive: queries re-run when the Step becomes Done. `isReady`
  reads one row of the `steps` table, which changes only on state transitions.
  Batches write the `progress` table, so a gated query does not re-run on every
  Batch. For a Rebuild it also reads the sentinel record and the sentinel's
  scheduled job (ADR 6), which change once per run.
- Every gated read adds one component query. That cost is small, but heavy hot
  paths may want to read it once per request.
- After a detected Snapshot Import, `isReady` is false for Rebuilds until the
  next Apply rebuilds them. Migrations and Seeds keep the imported state (ADR
  6).
