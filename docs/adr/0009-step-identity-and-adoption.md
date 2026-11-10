# 9. Step identity and Adoption

Date: 2026-11-10

## Status

Accepted. Implemented in 0.1.0. Revised on 2026-11-10 by ADR 12 (clean-slate
API).

## Context

Upstream keys status by function name, so moving or renaming a file re-runs a
migration. Teams switching from `@convex-dev/migrations` have long Done
histories that must not replay. Mongock imports another tool's history with an
expected-count check. Flyway, Liquibase and Mongock identify changes by declared
ids.

## Decision

- A Step's identity is the required id string passed to `m.seed`, `m.migrate`,
  `m.once` or `m.rebuild` (ADR 12). Ids are unique in the Plan; `m.plan` throws
  at module load on a duplicate. An id starts with a letter or digit and uses
  only letters, digits and `_ . : / -`. Recommended form:
  `YYYY-MM-DD-short-description`.
- `m.adopt(components.migrations)` returns an internal mutation taking
  `{ expectCount }`. The app exports it as `adopt`. It reads the upstream
  component's status (the app can call it; this component cannot), refuses when
  the number of Done rows differs from `expectCount`, and records every upstream
  Done name as Done with Via `adopted`. It returns `{ adopted, alreadyDone }`
  and is idempotent. It clears the error, the progress and the run id of an
  earlier attempt on an adopted name. While a live run works on one of the names
  it refuses and records nothing; run `cancel` first.
- An upstream migration that is still in the Plan keeps the upstream function
  name as its id (for example `"migrations:backfillX"`), so the adopted record
  applies to it. Adopted names not in the Plan become Done Orphans.

## Consequences

- File moves and renames never re-run a Step.
- Switching from upstream is one command per deployment,
  `npx convex-improved-migration adopt --expect-count <n>`, with a count the
  operator can check against `lib:getStatus`.
- The upstream component can be removed from `convex.config.ts` after Adoption
  on every deployment.
