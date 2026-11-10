# 8. Verification via `needs`

Date: 2026-11-10

## Status

Accepted. Implemented in 0.1.0. Revised on 2026-11-10 by ADR 12 (clean-slate
API).

## Context

Prisma 8 attaches a precheck ("has work to do") and a postcheck ("resolved all
violations") to every data transform. Ecto's backfill guide re-queries the
unmigrated condition until it is empty. DynamoDB runs a violation detector after
an index backfill. The motivating app ships read-only paginated verifiers before
each contract release.

## Decision

A table Migration may declare `needs(doc): boolean`, a pure predicate for "this
document still needs work". The component uses it:

- in each Batch, to skip documents where `needs` is false (counted as skipped,
  not processed), which makes re-runs cheap and idempotent;
- after the last Batch, in a verify pass that pages the table (or the `range`)
  and counts documents where `needs` is still true. The Step becomes Done only
  if the count is zero; otherwise it is Failed with the count and up to 10
  sample ids. `status` keeps the count as `remaining` until the next verify pass
  starts. The next Apply scans the table again from the start, where `needs`
  skips migrated documents, and verifies again;
- in tests, through `expectNoneNeed(t, id)` from the `/test` export.

Migrations without `needs` visit every document and are Done after the last
Batch, as upstream. Rebuilds take no `needs` and behave the same way. `needs` is
positive ("still needs work") so it reads the same way in the Batch filter and
in the verify count.

## Consequences

- One optional field gives idempotency, a release gate and a test assertion.
- The verify pass re-reads the table once. For large tables that doubles the
  read cost; `needs` stays optional for that reason.
- A verify failure can mean old code wrote the old shape during the backfill.
  The error says so and tells the operator to run Apply again.
- Schema-shaped checks are better served by Convex schema validation on push
  (ADR 7).
