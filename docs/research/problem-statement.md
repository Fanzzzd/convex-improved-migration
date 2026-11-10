# Problem statement

Date: 2026-11-10.

A production Convex app that used `@convex-dev/migrations` 0.3.x hit the six
problems below. They are the motivating requirements for this component, not its
full scope. The research in this directory cites them as "problem 1" to "problem
6".

1. The post-deploy queue `runAll`, a `migrations.runner([...])` list, grew to
   about a hundred entries. A fresh deployment replays all of them. Upstream has
   no baseline concept and no way to record a migration as done without running
   it.
2. `convex run migrations:runAll` returns after the first batch of the first
   migration. The rest chain through `scheduler.runAfter(0)`. Setup scripts and
   CI cannot wait for the series to finish, and a failure in the chain does not
   fail the caller. `runToCompletion` handles one migration only.
3. Readiness flags for expand, backfill and contract sequences live in an app
   table. Readers degrade when the flag is missing, so an empty new deployment
   needs a migration just to set flags it never needed.
4. Rebuilding derived data such as counters, search postings and fact tables
   after `convex import` is mixed into the migration queue. If the component's
   status is imported too, completed names are skipped and nothing rebuilds.
5. Reference-data seeds sit in the migration queue and are duplicated in a dev
   seed script.
6. Pruning completed migrations is undocumented upstream. The app had to invent
   its own archive workflow.

Related upstream issues in get-convex/migrations: #5 (a first-batch failure is
not saved), #16, #30 (arguments), and the open docs PR #77.

## Constraints as first stated

The research started from this list of Convex constraints: transactions limited
to about 4,096 reads or writes and 1 s per mutation, no DDL, schema validated
against all documents on push, rolling deploys with old clients, components with
isolated tables, and triggers not run by `convex import`. The survey checks each
one against Convex source and docs and corrects the transaction limits in
`industry-survey.md`.
