# Research: baseline vs replay for a fresh Convex deployment

Date: 2026-11-10.

Question: in a production Convex app that motivated this project, the `runAll`
list of `@convex-dev/migrations` grew to about a hundred entries that mix
reference-data seeds and permission grants, readiness flags, and legacy
backfills or repairs. A fresh local deployment replays all of them. How do
mature migration systems and Convex itself separate "build a new database at the
current baseline" from "replay history", and what should a migration component
do with each role?

## Short answer

Every mature system surveyed builds a new database from a current baseline and
only replays migrations newer than that baseline. Rails loads the schema file
and runs seeds [1][2]. Django squashes and drops elidable data operations
[4][5]. Prisma, Flyway, Laravel and Ecto all load one baseline file
[6][7][8][10][11]. Data backfills are the first thing these systems drop from
the fresh-install path. Seed data lives in a separate idempotent seed step, not
in migrations [1]. Convex and `@convex-dev/migrations` 0.3.x have no baseline
concept. Completed migrations are skipped by name, and there is no API that
records a migration as done without running it [13][14]. The component's own
docs never discuss pruning `runAll` [15][16]. For such an app: move role 1 into
an idempotent seed function, make the fresh-deployment path write the current
readiness flags as part of that baseline, and move the "rebuild after import"
backfills into a named rebuild runner. Then `runAll` holds only migrations that
production has not finished. No primary source defines how a readiness flag
should behave on a brand-new deployment. That part is this note's inference,
marked below.

## A. Baseline vs replay in mature systems

### Rails

- The guide says migrations "are not the authoritative source for your database
  schema". It says creating a new database "by loading the schema file via
  `bin/rails db:schema:load`" is faster and less error prone than replaying the
  entire migration history [1].
- The schema file "is the authoritative source for rebuilding that database",
  which "makes it possible to delete or prune old migration files". Databases
  that already ran a deleted migration keep its timestamp in an internal table
  and show `NO FILE` for it [1].
- `db:prepare` is idempotent. On a missing database it acts like `db:setup`
  (create, load schema, seed). On an existing database with tables it does
  nothing more than pending migrations; it does not reload seed data [1].
- Data migrations: "In Rails, it is generally not advised to perform data
  migrations using migration files." The stated reasons are that schema and data
  changes "have different lifecycles and purposes", are hard to roll back, and
  can run long. The guide points to the `maintenance_tasks` gem instead [1].
- Seeds: migrations can modify data "in an existing database that can't be
  destroyed and recreated, such as a production database". For initial data, use
  `db/seeds.rb`. Seed code "should be idempotent so that it can be executed at
  any point in every environment" [1].

### Django

- Squashing reduces many migrations to a few. `RunSQL` and `RunPython` "can't be
  optimized through unless they are marked as `elidable`" [4].
- The `elidable` argument "determines whether or not the operation will be
  removed (elided) when squashing migrations" [5]. `RunPython` is the operation
  the docs name for data migrations [5]. So a data migration marked elidable
  disappears from the squashed history.
- The squashed migration carries `replaces`. Instances part-way through the old
  history keep using the old files; "new installs will use the new squashed
  migration and skip all the old ones" [4].
- The recommended process is two releases: squash and keep old files, wait until
  every system has upgraded, then delete the old files and remove `replaces`
  [4].

### Prisma

- Baselining tells Prisma Migrate "to assume that one or more migrations have
  already been applied". `prisma migrate resolve --applied <name>` records a
  migration in `_prisma_migrations` without running it [6].
- Squashing in production: delete the migrations folder, generate one migration
  with `prisma migrate diff --from-empty --to-schema`, then mark it applied on
  production with `migrate resolve --applied`. "New checkouts only get one
  single migration" [7].
- Hand-written SQL in old migrations "will not be retained" by a squash and must
  be re-added [7].

### Flyway

- Baseline migrations (`B` prefix) "are only used when deploying to new
  environments". New environments start from the latest baseline, and every
  migration below its version is marked `ignored`. In an environment where
  migrations already ran, baseline migrations are ignored [8].
- `baselineOnMigrate` is a separate feature for adopting Flyway on an existing
  non-empty database with no history table. Flyway skips it when the database
  looks empty [9].

### Laravel and Ecto

- Laravel `schema:dump --prune` writes a schema file and deletes existing
  migrations. When no migrations have run, Laravel executes the schema file
  first and then "any remaining migrations that were not part of the schema
  dump" [10].
- Ecto `mix ecto.load` "Loads the current environment's database structure ...
  from a previously dumped structure file". `--skip-if-loaded` skips the load
  when the migrations table already exists [11].

### GitLab (batched background migrations)

GitLab is the closest analogue to Convex async backfills, because its background
data migrations run after deploy.

- "You cannot depend on any batched background migration being completed until
  after it is finalized." Finalization calls
  `ensure_batched_background_migration_is_finished`; if the migration is not
  finished, "the system will execute the batched background migration inline"
  [12].
- Finalized background migrations are later deleted by GitLab's squashing
  process, which writes `db/init_structure.sql` and "removes all migrations from
  the previous version" [12][12a].

Pattern across all of A: schema state and seed data form the baseline. Data
backfills exist only to move existing rows and leave the history once every live
database has run them.

## B. Convex and `@convex-dev/migrations`

The motivating app pinned `@convex-dev/migrations` 0.3.6 when this note was
written. Source links below use the `v0.3.6` tag. The latest tag is v0.3.7,
which only changes the test entrypoint [17].

- **State model.** The component stores one row per migration name with
  `cursor`, `isDone`, `processed`, `error`, timestamps and a `workerId` [13]. A
  serial run skips any name whose row is `isDone` [14][15].
- **No "mark done" API.** The component's public functions are `migrate`,
  `getStatus`, `cancel`, `cancelAll` and `clearAll` [14]. `migrate` rejects any
  `fnHandle` that does not start with `function://`, so the CLI cannot call it
  directly [14]. `isDone` becomes true only from the result of running the
  migration function. Nothing records a migration as done without running it.
  `clearAll` deletes status rows, which makes migrations runnable again [14].
  Unlike Prisma's `migrate resolve --applied` [6], there is no baseline command.
- **Chaining.** `runner([...])` creates a function handle for every listed
  migration before it starts [18]. `migrate` runs one batch, then schedules the
  next batch or the next unfinished migration with `scheduler.runAfter(0, ...)`
  [14]. The CLI call returns after the first migration's first batch. Each entry
  costs at least one scheduled mutation, run in series. Since 0.3.6 the runner
  reads status from a stale snapshot and does nothing if any migration in the
  series is already in progress [17][18].
- **Waiting for completion.** The README offers `lib:getStatus --watch` for live
  status [15]. `runToCompletion(ctx, component, fnRef)` runs one migration
  synchronously inside an action, batch by batch, and stops if the action
  crashes or is canceled [15][18]. It takes a single migration, not a series.
  Convex limits actions to 30 minutes on the Convex runtime and 10 minutes on
  Node [26]. I found no CLI flag that runs a series and waits.
- **Deploy integration.** The README recommends
  `npx convex deploy --cmd 'npm run build' && npx convex run convex/migrations.ts:runAll --prod`
  [15]. `convex deploy` itself can run a function only for preview deployments
  (`--preview-run`); it ignores that flag for production [20][21].
- **Pruning.** Neither the README [15], the open docs PR #77 by the maintainer
  (`team-workflows.mdx`, unmerged) [16], nor the Stack posts [22][23][24]
  discuss removing completed entries from `runAll`. PR #77 states the intended
  model: completed migrations are skipped, "so the only migrations that actually
  do work are the new ones" [16]. The Lightweight Migrations post argues for
  committing migration code so there is "a clear history" and so others can
  update other instances [24]. The motivating app wrote its own archive rule to
  fill this gap, and that rule matches the component source.
- **Seeding a new deployment.** The Stack seeding post puts an idempotent
  `internalMutation` as the default export of `convex/init.ts`. It "adds data,
  or returns if data has already been added". It is called with
  `convex dev --run init` locally and `convex deploy --preview-run init` for
  previews [19]. On breaking schema changes the author updates `init`, clears
  tables and re-initializes [19]. `convex dev --run` runs a named function as
  part of the dev startup steps [25]. The post does not mention migrations.
- **Rehearsal.** Convex's own agent skill `convex-migrate-rehearse` seeds a
  preview deployment from a production snapshot with `convex import`, then runs
  the backfill there before production [27]. That is the Convex-documented way
  to test history against real data. It does not involve replaying migrations on
  an empty database.

## C. Readiness flags on a brand-new deployment

- Stripe's dual-write post covers four steps (dual write, move reads, move
  writes, delete old data). It does not cover new environments or flags [28].
- Convex's Intro to Migrations lists dual-write and dual-read orders and says
  the migration "isn't done until there are no more readers or writers of the
  old format" [22]. It does not describe a readiness flag or new deployments.
- GitLab gates dependents on finalization, and finalization runs unfinished work
  inline [12]. Any database past the finalize step has the data, whether fresh
  or upgraded. GitLab gates on a migration step, not on a runtime flag.
- LaunchDarkly migration flags describe a "temporary flag" moving through two to
  six stages. The page names no default stage and says nothing about new
  environments [29].

Gap: no source I found says "fresh deployments start with the flag ready" or
"the flag defaults to ready when there is no legacy data". Two conventions are
supported only indirectly. Baseline systems (A) start new databases at the
current state, which implies a fresh database should not pass through "not
ready". Every dual-write source ends by deleting the old path [22][28], which
maps to deleting the flag row once the old read path is gone.

## D. Rebuilding derived data after restore or import

- convex-helpers triggers: "If you upload data through `npx convex import`, the
  triggers won't run." The same applies to dashboard edits and unwrapped
  mutations [30].
- Aggregate component: attaching an aggregate to existing data uses idempotent
  writes (`insertIfDoesNotExist`, `idempotentTrigger`) plus a paginated backfill
  run through `@convex-dev/migrations` [31]. Repair is "start over":
  `aggregate.clear(ctx)` or rename the component, then run the same backfill.
  The alternative diffs the source table against the aggregate [31]. So Convex
  treats rebuild as a re-runnable backfill with a clear step. The aggregate
  README does not say it should live in a permanent post-deploy list.
- Convex import keeps `_id` and `_creationTime`, and built-in indexes "work on
  the new data without needing time for re-backfilling" [32].
  Application-maintained tables, such as counters and search postings, are
  ordinary tables. They are correct after import only if the zip included them
  and they matched the source tables. `--replace-all` empties schema tables
  missing from the zip [33]. Backups exclude scheduled functions [34]. The docs
  do not say whether component tables are part of a default export [34].
- Rails ships `reset_counters` as a separate method that recomputes counter
  caches with a count query, for new counter columns or corrupted counters [3].
  It is not a migration.
- PostgreSQL's `pg_dump`/`pg_restore` run `REFRESH MATERIALIZED VIEW` as a final
  restore pass, after data and grants [35]. Postgres rebuilds derived data as
  part of restore, not as a migration.

Pattern: derived data gets a dedicated, idempotent rebuild operation (clear then
backfill, or recompute). Systems run it on restore or on demand. None of the
sources ties it to the migration history.

## What applies to a Convex app

The motivating app's list splits by name prefix into roughly four groups: seeds,
grants and initializers; `mark*Ready` readiness flags; backfills and clears; and
repairs, renames and normalizations. The counts are approximate.

1. **Seeds and grants (role 1).** Rails seeds [1] and Convex `init` [19] say the
   same thing: reference data belongs in one idempotent function that every
   environment can run at any time. Seed and grant entries should move into a
   production-safe seed, separate from dev-only fixtures. Production still needs
   each entry to stay in `runAll` until its run is recorded done. After that the
   seed owns it.
2. **Readiness flags (role 2).** A fresh database has no legacy rows, so every
   gated reader is already correct on the new path. The baseline systems in A
   start new databases at the current state [1][8][10]. The inference: the
   fresh-deployment seed should write every readiness flag that is still live,
   in the same transaction as role 1. Deleting the flag once the old read path
   is gone is the only cleanup the sources support [22][28]. Writing a flag on a
   deployment with legacy rows would skip the backfill. The seed must therefore
   check that it runs on an empty deployment, or write flags only from the setup
   script. Prisma's `resolve --applied` [6] is the precedent for "record as done
   without running" on purpose, and Convex lacks it [14].
3. **Backfills, clears and repairs (role 3).** Two groups.
   - Pure legacy moves (renames, normalizations, clears, one-off repairs). These
     are what Rails, Django, Prisma and GitLab drop from the fresh path
     [1][4][7][12]. Pruning them from the list is enough. No new mechanism is
     needed.
   - Rebuild-after-import entries (counters, denormalized totals, search
     postings, cached cards). Triggers do not run on import [30], so these are
     needed after a restore. The aggregate component and Rails `reset_counters`
     model this as a separate, idempotent clear-and-rebuild operation [3][31].
     Move them to a named runner with `reset: true` semantics so a rerun
     recomputes instead of skipping done names [15]. Keeping them in `runAll`
     makes them run only once per deployment: after a later import, the
     component status still says `isDone`, so `runAll` skips them. That defeats
     the "rebuild after `convex import`" purpose unless an operator passes
     `reset: true` or clears status. This follows from the source [14]; I did
     not reproduce it on a deployment.
4. **Setup race.** `convex run migrations:runAll` returns after one batch of the
   first migration [14]. A dev seed script that runs next starts while the
   remaining scheduled mutations are still chaining. A failure partway stops the
   chain without failing setup [15]. Two source-backed options exist. An
   internal action can call `runToCompletion` for each migration in order,
   inside the 30-minute Convex-runtime action limit [18][26]. Or setup can poll
   `lib:getStatus` until the last name is `isDone` [15]. Once roles 1 and 2 move
   into a synchronous seed mutation, fresh setup no longer depends on the chain
   at all, and the remaining entries are no-ops on empty tables.

## Gaps / unverified

- No primary source states how a readiness or migration flag should be
  initialized on a brand-new deployment (section C). The recommendation in item
  2 is inference.
- The Flyway docs URL given in some search results
  (`documentation.red-gate.com/flyway/flyway-concepts/migrations/baselines`)
  returned 404; the current page [8] was used instead.
- The Convex backup and import docs do not say whether component tables (for
  example the migrations component's status table) are included in a default
  export or restored by import [32][34]. Whether a restored deployment keeps or
  loses migration status is unverified.
- `convex dev --until-success` appears in the reference [25], but the seeding
  post does not use the exact `predev` script that search summaries attributed
  to it [19].
- PR #77 in get-convex/migrations [16] is open and unmerged; it is
  maintainer-authored but not released documentation.
- The Stack posts fetched [19][22][23][24] showed no author or date in the
  fetched content.
- The claim in item 3 that `runAll` skips rebuild entries after an import was
  derived from component source, not observed on a deployment.
- The Ecto `mix ecto.dump` page and the Laravel seeder docs were not fetched.

## Sources

1. Rails Guides, Active Record Migrations:
   https://guides.rubyonrails.org/active_record_migrations.html (sections 4.3,
   6.1, 8, 9, 10.2)
2. Same page, "Migrations and Seed Data":
   https://guides.rubyonrails.org/active_record_migrations.html#migrations-and-seed-data
3. Rails API, `ActiveRecord::CounterCache::ClassMethods#reset_counters`:
   https://api.rubyonrails.org/classes/ActiveRecord/CounterCache/ClassMethods.html
4. Django 5.2, Migrations, squashing and data migrations:
   https://docs.djangoproject.com/en/5.2/topics/migrations/
5. Django 5.2, Migration operations (`RunSQL`, `RunPython`, `elidable`):
   https://docs.djangoproject.com/en/5.2/ref/migration-operations/
6. Prisma, Baselining a database:
   https://www.prisma.io/docs/orm/prisma-migrate/workflows/baselining
7. Prisma, Squashing migrations:
   https://www.prisma.io/docs/orm/prisma-migrate/workflows/squashing-migrations
8. Redgate Flyway, Baseline migrations:
   https://documentation.red-gate.com/fd/baseline-migrations-273973336.html
9. Redgate Flyway, Baseline On Migrate setting:
   https://documentation.red-gate.com/fd/flyway-baseline-on-migrate-setting-277578974.html
10. Laravel 12.x, Migrations, Squashing Migrations:
    https://laravel.com/docs/12.x/migrations#squashing-migrations
11. Ecto SQL, `mix ecto.load`:
    https://ecto-sql.hexdocs.pm/Mix.Tasks.Ecto.Load.html
12. GitLab, Batched background migrations:
    https://docs.gitlab.com/development/database/batched_background_migrations/
    12a. GitLab, Migration squashing:
    https://docs.gitlab.com/development/database/migration_squashing/
13. get-convex/migrations v0.3.6, component schema:
    https://github.com/get-convex/migrations/blob/v0.3.6/src/component/schema.ts
14. get-convex/migrations v0.3.6, component `lib.ts` (`migrate` lines 43-207,
    chaining 128-175, `cancel`/`cancelAll`/`clearAll` 280-360):
    https://github.com/get-convex/migrations/blob/v0.3.6/src/component/lib.ts
15. get-convex/migrations v0.3.6, README (serial behavior, `getStatus --watch`
    line 328, production deploy line 357, `runToCompletion` line 462):
    https://github.com/get-convex/migrations/blob/v0.3.6/README.md
16. get-convex/migrations PR #77 (open), `docs/team-workflows.mdx` at 1dbb9e5:
    https://github.com/get-convex/migrations/pull/77
17. get-convex/migrations CHANGELOG:
    https://github.com/get-convex/migrations/blob/main/CHANGELOG.md
18. get-convex/migrations v0.3.6, client `index.ts` (`runner` line 146,
    `anyInProgress` line 204, `runToCompletion` line 778):
    https://github.com/get-convex/migrations/blob/v0.3.6/src/client/index.ts
19. Convex Stack, Seeding Data for Preview Deployments:
    https://stack.convex.dev/seeding-data-for-preview-deployments
20. Convex docs, `npx convex deploy`:
    https://docs.convex.dev/cli/reference/deploy
21. Convex docs, Preview deployments:
    https://docs.convex.dev/production/hosting/preview-deployments
22. Convex Stack, Intro to Migrations:
    https://stack.convex.dev/intro-to-migrations
23. Convex Stack, Migrating Data with Mutations:
    https://stack.convex.dev/migrating-data-with-mutations
24. Convex Stack, Lightweight Migrations:
    https://stack.convex.dev/lightweight-zero-downtime-migrations
25. Convex docs, `npx convex dev`: https://docs.convex.dev/cli/reference/dev
26. Convex docs, Limits: https://docs.convex.dev/production/state/limits
27. get-convex/agent-skills, `convex-migrate-rehearse` at f60629d:
    https://github.com/get-convex/agent-skills/blob/f60629d7c6c1f27eb58a56260546d2445049274d/skills/convex-migrate-rehearse/SKILL.md
28. Stripe Engineering, Online migrations at scale (Jacqueline Xu, 2017-02-02):
    https://stripe.com/blog/online-migrations
29. LaunchDarkly, Migration flags:
    https://launchdarkly.com/docs/home/flags/migration
30. get-convex/convex-helpers README, Triggers (line 1217-1225 at 964f2d4):
    https://github.com/get-convex/convex-helpers/blob/964f2d4ec97a19bbc258ddbdbbb522044fec230c/packages/convex-helpers/README.md#triggers
31. get-convex/aggregate README, Operations (lines 420-505 at 7583a1e):
    https://github.com/get-convex/aggregate/blob/7583a1e0d2dda716dc51f11955944d47077e583f/README.md#operations
32. Convex docs, Data import:
    https://docs.convex.dev/database/import-export/import
33. Convex docs, `npx convex import`:
    https://docs.convex.dev/cli/reference/import
34. Convex docs, Backup and restore:
    https://docs.convex.dev/database/backup-restore
35. PostgreSQL commit, "Fix pg_dump/pg_restore to emit REFRESH MATERIALIZED VIEW
    commands last" (Tom Lane, 2017-08-03):
    https://www.postgresql.org/message-id/E1ddNne-0001jw-Vx@gemulon.postgresql.org
