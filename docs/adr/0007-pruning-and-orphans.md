# 7. Pruning and Orphans

Date: 2026-11-10

## Status

Accepted. Partly implemented in 0.1.0; see below.

## Context

Upstream documents no way to remove completed migrations from the list. The
motivating app invented an archive procedure
(`docs/research/problem-statement.md`). Rails shows `NO FILE`, Ecto
`FILE NOT FOUND`, Flyway `Missing`; Django prunes stale rows and squashes over
two releases; GitLab deletes job code after the next required stop.

## Decision

- Removing a Step from the Plan is the pruning operation. Its recorded state
  stays as an Orphan.
- `status` lists Orphans with their state and Via, and shows the state of every
  Plan Step. A Step is safe to remove once every deployment that matters reports
  it Done.
- Apply refuses to run when it finds an unfinished Orphan: a Step that was
  removed from code before it finished on this deployment. The error names the
  Step and the action (put the Step back, or `mark-done` with a reason).
  `mark-done` accepts a recorded Orphan id. A dry run refuses with the same
  error, and `check` also fails while an unfinished Orphan exists.
- Orphans are measured against the whole Plan. `apply({ only })` runs one Step
  and does not report the other Plan Steps as Orphans.
- No baseline label in 0.1.0. Convex validates the schema against all documents
  on push, so a stale deployment whose data still has an old shape fails at push
  once the contract release narrows the schema.

Not built in 0.1.0: a `retired` list of pruned ids and a `baseline` command that
marks them Done. Both were proposed so that a stale deployment fails at Apply,
and both are deferred.

## Consequences

- The Plan holds only Steps some deployment still needs. A fresh deployment's
  first Apply stays short.
- One Plan per component mount. A second Plan on the same mount sees the first
  Plan's unfinished Steps as unfinished Orphans and refuses to run. A second
  Plan needs a second mount of the component under another name.
- A stale deployment that never saw a pruned Step is not detected by the
  component; schema validation on push is the backstop. If that proves too weak,
  a `baseline` label checked on Apply can be added later.
