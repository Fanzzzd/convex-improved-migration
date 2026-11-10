# 2. Done is earned, never assumed

Date: 2026-11-10

## Status

Accepted. Implemented in 0.1.0.

## Context

A fresh deployment replays every entry in `runAll`. Upstream has no way to
record a migration as Done without running it. Every SQL tool surveyed has one
(Rails schema load, Django `--fake`, Prisma `resolve --applied`, Liquibase
`changelog-sync`, Atlas `--baseline`), and the careful ones guard it: Prisma 8
checks the tables before `db sign`, Atlas refuses a non-clean database. GitLab
marks a background migration finished at enqueue when its table is empty.

The tempting shortcut, "no history means a fresh deployment, so mark everything
Done", is unsafe: an existing production deployment installing this component
for the first time also has no history, and would skip every pending Migration.

## Decision

A Step becomes Done in exactly three recorded ways, stored as Via:

- `ran`: it completed on this deployment.
- `marked`: an operator ran `mark-done <id> --reason <text>`, which calls
  `operate({ op: "markDone", id, reason })`. The reason is required and kept in
  the Event log. `mark-done` refuses a Step that is already Done, in the same
  transaction that would write it; `reset` it first to record it again. A Done
  Rebuild due for a version change or a rebuild request can still be marked.
  While a snapshot import is suspected, `mark-done` refuses every Rebuild,
  because the next Apply rebuilds them all.
- `adopted`: copied from `@convex-dev/migrations` by Adoption, which takes an
  `expectCount` and refuses on mismatch (Mongock's legacy import).

The component never infers Done from the absence of history or data. On a fresh
deployment, Apply runs each Migration in the current Plan over empty tables;
each costs one empty Batch, plus one empty verify page when it declares `needs`.
Pruning (ADR 7) keeps that list short.

## Consequences

- A fresh deployment reaches the current state by running the current Plan, not
  about a hundred historical entries, once old Steps are pruned.
- First install on an existing deployment is safe by default: it runs what is
  pending. Teams with long upstream history use Adoption instead of a replay.
- `status` shows Via for every Done Step, so a marked or adopted Step is
  auditable.
- There is no `baseline` command in 0.1.0 (ADR 7). `mark-done` once per Step is
  the explicit form.
