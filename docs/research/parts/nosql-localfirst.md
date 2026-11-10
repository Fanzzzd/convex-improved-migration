# Research part: document/NoSQL migration tools and local-first schema evolution

Date: 2026-11-10.

Scope: this part extends `docs/research/baseline-prior-art.md` (the "prior
note"). It covers MongoDB, Mongock, migrate-mongo, Prisma for MongoDB, Firestore
and fireway, DynamoDB, Realm/Atlas Device Sync, Couchbase, Replicache, Zero,
ElectricSQL, and Convex's own guidance on old clients. SQL tools and Convex
internals are covered by other parts.

Appendix of `docs/research/industry-survey.md`. Citations `[Nn]` refer to the
Sources list at the end of this file. Citations `[Pn]` refer to source n of
`docs/research/baseline-prior-art.md`.

Source clones were read at pinned tags and never executed: `flamingock/mongock`
at `mongock-5.5.1` (70643af), `flamingock/mongock-docs` at e49c8b6,
`seppevs/migrate-mongo` at `v14.0.7` (1f5e5f9), `kevlened/fireway` at `1.1.0`
(884c78b), `rocicorp/mono` at `zero/v1.11.4` (be94346), `get-convex/convex-js`
at `npm/1.49.0` (58c383e).

## Short answer

- Document databases do not force a migration step, so their vendors push
  "tolerate old shapes" first. MongoDB's schema versioning pattern stores a
  version field per document and lets the application handle each version,
  migrating all at once, on access, or never [N1][N2]. Prisma for MongoDB has no
  Migrate at all and offers three team policies instead: on-demand, no breaking
  changes, all at once [N25]. AWS describes the same choice for DynamoDB as
  gradual versus bulk update [N30].
- Ordered migration runners for document stores (Mongock, migrate-mongo,
  fireway) all keep a history collection in the target database. They differ in
  what counts as "done". Mongock keys by id plus author and keeps an append-only
  state log [N13][N14]. migrate-mongo keys by file name, optionally plus file
  hash [N21]. fireway keeps only a high-water mark by semver and refuses to run
  after a recorded failure [N29].
- Mongock has three ideas no SQL tool in the prior note had: `runAlways` units
  that execute every run but are recorded once [N13], a "system update" phase
  that migrates the tool's own history collection with its own change units
  before user migrations run [N16][N17], and a "legacy migration" that imports
  another tool's history with an expected-count check [N9].
- The local-first systems treat old clients as a protocol problem, not a data
  problem. Replicache and Zero send a schema identifier with every connection.
  When the server cannot serve it, the client gets `VersionNotSupported` or
  `SchemaVersionNotSupported` and calls `onUpdateNeeded`, which reloads the page
  by default [N43][N45][N48][N50]. Zero checks compatibility structurally: every
  table and column the client was built against must still exist with the same
  type [N49].
- Zero publishes the deploy order rule that matches expand/contract exactly.
  Expand: database, then API, then client. Contract: client, then API, then
  database [N48]. Realm says the same for synced data: remove a property from
  the client model and leave it on the server [N39].
- Derived client state is disposable in all three local-first systems. A
  Replicache schema change opens a new local database [N44]. Electric
  invalidates every shape on a table whose columns change, and clients discard
  local data and re-sync [N51]. Nothing replays history.
- Convex's own docs require functions to stay backwards compatible because users
  "might still be running the old version of your website" [N52]. The Convex
  browser client sends only its library version, not an app schema version
  [N53]. Convex has no built-in equivalent of `onUpdateNeeded`.

## A. Document and NoSQL systems

### MongoDB schema versioning pattern

- The MongoDB manual says the pattern "lets you have different versions of your
  schema in the same collection, which avoids large-scale schema migrations"
  [N1]. The steps are: add a `schemaVersion` field to existing documents with
  one `updateMany`, then insert new documents at version 2 [N1].
- Reads and writes must handle every version. "Your query must check all
  possible locations for a field value depending on the document's schema
  version" [N1]. Updates use `schemaVersion` inside an update pipeline to pick
  the field to write [N1].
- The manual page describes no lazy upgrade and no background migration. Old and
  new documents coexist [N1].
- The 2019 MongoDB blog post that introduced the pattern names three choices:
  "updating all documents to the new design, updating when a record is accessed,
  or not at all" [N2]. It says documents without the field can be treated as
  version 1 [N2]. It adds that an index on a field at different levels may need
  two indexes "while you are migrating the documents" [N2].
- MongoDB schema validation offers levels that tolerate legacy documents.
  `moderate` validates inserts and updates to documents that are already valid.
  `strict`, the default, does not retroactively check existing documents, but
  updates to invalid documents fail [N3]. MongoDB 9.0 adds `constraint`, which
  scans all documents and fails `collMod` if any violates the validator [N3].
  `constraint` is the same contract Convex enforces on every schema push [N52].

Relevance for Convex: Convex cannot use `moderate`/`strict` tolerance. A
narrower schema cannot be pushed until all documents match [N52]. So in Convex
the version-per-document pattern can only live inside a schema union (for
example `v.union` of old and new shapes), and the contract step must wait until
the old branch is empty.

### Mongock

Mongock is a Java migration library. It started as a Mongobee fork [N9] and now
lives under the `flamingock` GitHub organization.

- Unit of work. A `@ChangeUnit` class has one `@Execution` method and a
  mandatory `@RollbackExecution` method [N4][N18]. Attributes are `id`, `order`
  (sorted as alphanumeric), `author`, `runAlways`, `systemVersion`, `failFast`
  (default true) and `transactional` (default true) [N4][N18]. Identity is `id`
  plus `author` [N4][N13].
- `@BeforeExecution`. An optional method that runs outside the native
  transaction, for DDL that MongoDB does not allow inside a transaction. It is
  tracked as its own history entry, and a failure aborts the run, is recorded as
  failed, and is retried next time [N4]. Its id gets the suffix `_before` [N18].
- Transactions. By default each change unit runs in its own native transaction
  when the driver supports it. Without native transactions, Mongock calls the
  rollback method by hand [N4][N8]. The `EXECUTION` strategy wraps all units in
  one transaction; the docs call it "unnatural" and recommend the per-unit
  default [N6].
- History collection. Every attempt appends a `ChangeEntry` with a state:
  `EXECUTED`, `FAILED`, `ROLLED_BACK`, `ROLLBACK_FAILED` or `IGNORED` [N15].
  "Already executed" is derived: group entries by id and author, drop `IGNORED`,
  `FAILED` and `ROLLBACK_FAILED`, take the newest remaining entry, and count it
  only if it is `EXECUTED` [N14]. A unit that was rolled back is therefore
  pending again. `trackIgnored` optionally logs skipped units as `IGNORED` [N6].
- `runAlways`. The executor runs a unit if it is not already executed or if it
  is `runAlways`. It writes a history entry only when the unit was not executed
  before, so a `runAlways` unit is recorded once and then runs silently on every
  start [N13].
- Failure and resume. "Mongock is designed to run successfully the entire
  migration or fail." The next run continues from the failed change unit,
  included [N5]. If the history write itself throws, the executor logs it at
  debug level and continues [N13]. That is a gap: a unit can succeed with no
  record.
- Lock. The driver persists a distributed lock in `mongockLock`. Defaults: the
  lock lease is 1 minute and is extended automatically while the run lasts; a
  waiting instance quits after 3 minutes; it retries every 1 second [N7]. The
  executor checks for pending units, acquires the lock, then reloads history
  before running, so a second instance that waited does no duplicate work [N16].
  `throwExceptionIfCannotObtainLock` defaults to true [N6].
- System update. Before user migrations, the runner executes a separate "system
  update" executor [N19]. It scans Mongock's own `@SystemChange` units and runs
  them under the same lock and history rules [N16]. `system-change-00001` adds
  missing fields to the history collection and back-fills a `systemChange` flag
  on old entries [N17]. The tool migrates its own state table with its own
  migration mechanism.
- Legacy migration. Mongock can import another tool's history collection. Config
  names the origin collection, a field mapping, `changes-count-expectation` and
  `run-always` [N9]. If the imported count differs from the expectation, Mongock
  throws [N9]. Mongobee needs only the origin name because the field names match
  [N9]. The importer is itself a system change unit, chosen per `run-always`
  [N16].
- Version windows. `startSystemVersion` and `endSystemVersions` limit a run to
  units whose `systemVersion` falls in a range [N6].
- Rolling deploys. The docs warn that "the old version of the software is likely
  to still be running" during a migration and recommend backwards compatible
  units and a 2-stage approach: additions first, removal in a later deployment
  [N4]. They also say a non-transactional unit must be idempotent and must
  "reduce its execution time in every iteration" so that repeated interruptions
  still converge [N4].
- Operations. The open source CLI has `migrate all`. `migrate up-to-change`,
  `undo all`, `undo up-to-change`, `state db`, `state code-base` and
  `state compare` are marked PRO [N10].
- Observability. Three events: start, success and failure [N12][N19].
- Testing. JUnit 5 base classes reset Mongock's lock and history collections
  after each test and run the migration on demand. A runner instance can run
  only once, so tests build a new one per run [N6][N11].

### migrate-mongo

- State. One changelog collection (default `changelog`) with `fileName`,
  `appliedAt` and a `migrationBlock` timestamp shared by all files applied in
  one `up` run [N20][N23]. `status` lists migration files on disk and marks each
  `PENDING` or with its applied date [N21]. Changelog rows whose file was
  deleted do not appear in `status`, because the function maps over files only
  [N21]. Pruning a file is therefore silent.
- File hash. With `useFileHash: true`, the changelog also stores a SHA-256 of
  the file [N20][N23]. Status matches on name and hash, so an edited file
  becomes `PENDING` and runs again [N21]. The README says this "changes the
  behavior for every script" and every script must be safe to re-run [N23]. The
  hash is a re-run trigger, not a tamper check.
- Execution. `up` runs pending files in order. Each file's `up(db, client)`
  runs, then the changelog row is inserted as a separate write [N20]. The two
  writes are not atomic. If the changelog insert fails, `up` throws without
  clearing the lock [N20]. Transactions are opt-in inside a script, using
  `client.startSession()` [N23].
- Failure. The first failing file stops the run. The thrown error carries the
  list of files already migrated [N20].
- Rollback. `down` undoes the last applied file, or with `--block` every file in
  the last `migrationBlock` [N24].
- Lock. A lock collection with a TTL index. The default `lockTtl: 0` disables
  the lock [N22][N23]. `exist()` then `activate()` is a read followed by an
  insert, so two processes can both pass the check [N22].

### Prisma with MongoDB

- "There are no plans to add support for Prisma Migrate" for MongoDB. Unique
  indexes are managed with `db push` [N25].
- Prisma lists three data strategies [N25]:
  - On-demand: new fields are optional, and records fill in "as the
    application's users begin to enter" data. Or a required field gets a
    default, and a missing value "will be coerced" to it on read.
  - No breaking changes: only add optional fields, never rename or delete,
    enforced "by adding checks in the CI/CD process".
  - All at once: a script updates every document, then the field becomes
    required.

### Firestore and fireway

- Google has no Firestore migration tool. The Firestore best-practices page
  covers moving traffic to a new collection. Read the old location and fall back
  to the new one, run a batch job that copies data, then read only the new
  collection [N26]. A refinement adds a per-user migration status field and
  migrates users in batches chosen by a hash of the user id [N26]. It warns that
  rollback is hard "unless you do dual writes" and gives the "500/50/5" ramp
  rule for traffic to a new collection [N26].
- Firestore Enterprise edition has Pipeline DML `update()` and `delete()`
  stages. The docs' example backfills a field on every document missing it.
  Outside a transaction, documents are updated independently and "the pipeline
  halts on the first error, and previously modified documents remain written"
  [N27].
- Firestore import "operations don't trigger Cloud Functions" [N28]. This
  matches Convex, where triggers do not run on `convex import` [P30].
- fireway (archived on GitHub) is the common community runner. Files are named
  `v[semver]__[description].js` [N29]. Results go to a `fireway` collection with
  `installed_rank`, `version`, `script`, `checksum` (MD5), `execution_time` and
  `success` [N29].
- fireway's state model is a high-water mark. It reads the latest row by
  `installed_rank`, throws if that row has `success: false`, and runs only files
  whose version is greater than the latest version [N29]. A file added later
  with a lower version is never run. The checksum is written but never compared
  [N29].
- A failed script is still recorded, with `success: false`, and the run stops
  [N29]. The operator must delete the failed row or restore the database before
  the next run [N29].
- `--dryrun` patches `WriteBatch.commit` to return without writing, and the run
  counts added, created, updated, set and deleted documents [N29]. The emulator
  is the documented test target [N29].

### DynamoDB

- AWS's 2025 post on evolving a DynamoDB data model gives two options for
  existing items. Update the application "to tolerate instances where items
  retrieved from your table don't have the new attribute" and "gradually set the
  attribute", or run a bulk update [N30]. The gradual path means managing
  "different versions of the same entity in your table for an extended period"
  [N30].
- Bulk update tools: Step Functions or Glue [N30]. The Step Functions post
  splits the table into parallel scan segments (default 1,000), shuffles them,
  and gives each segment to a Lambda [N31]. A failed workflow can be redriven,
  but "some items will be re-processed", so updates must be idempotent [N31]. It
  warns that "DynamoDB doesn't provide snapshot isolation for a scan operation"
  [N31] and suggests optimistic locking against concurrent writers [N31].
- The Scan API pages 1 MB at a time and resumes from `LastEvaluatedKey` [N33].
  Parallel scan assigns items to segments by partition-key hash [N33]. A
  consistent `Scan` plus DynamoDB Streams is AWS's documented pattern for a
  consistent copy: scan, then apply the writes the stream recorded during the
  scan [N33]. Streams keep 24 hours of item changes, each record exactly once
  and in order per item [N34].
- A cost-focused post says the bulk executor should "quickly and harshly
  self-throttle" on throughput errors [N32].
- Readiness gate in the platform. A new global secondary index stays `CREATING`
  until backfill ends and is "not available for Query operations until its
  status changes from CREATING to ACTIVE" [N35]. After backfill, writes that
  violate the index key schema are rejected, and AWS recommends running a
  Violation Detector tool to find violations [N35].
- The November 2026 "bulk put items" feature accepts a condition per record. A
  version comparison means a record is "written only when the incoming copy is
  newer than the one already in the table", which "keeps stale exported items
  from overwriting newer application writes" [N36]. AWS recommends conditions
  "that make a second run of the same file a no-op" [N36]. Unwritten records go
  to an S3 report with the reason; progress shows processed and failed counts
  [N36].

### Realm and Atlas Device Sync

Atlas Device SDKs are deprecated and App Services has reached end of life
[N37][N39]. The design is still the main reference for on-device schema
versions.

- Local realms carry an integer schema version, default 0. Opening with a lower
  version, or the same version with a different schema, throws [N37]. Opening
  with a higher version runs the app's migration function [N37]. In Swift this
  is the `migrationBlock`, which receives `oldSchemaVersion` and enumerates
  objects of a type [N38].
- Additive changes (new or deleted properties) migrate automatically. New
  properties get a value only if the schema has a default [N37]. Renames are not
  direct: copy to a new property, then delete the old one [N37].
- `deleteRealmIfMigrationNeeded` deletes the local database instead of
  migrating. Both SDK pages say never to ship it to production [N37][N38].
- Synced realms accept only additive changes, "to ensure that older clients can
  sync with newer clients" [N37]. Removing a property or object type on the
  server is breaking; removing it from the client model is not [N39]. The
  guidance is to remove from the client only and leave the server schema in
  place [N39].
- When an old client omits a required property, the server fills a zero or blank
  value [N39]. When a new required property is added, existing server documents
  without it "do not sync to the client", which "may give client users the
  impression that the data has been lost" [N39].
- Breaking changes require terminating sync and a client reset, or a "partner
  collection": a new collection with the new schema, filled by an aggregation
  pipeline and kept in sync in both directions by database triggers [N39][N40].
  Breaking changes are not allowed through the CLI or automated GitHub deploys
  [N39].

### Couchbase Lite and Sync Gateway

- Couchbase documents are schemaless. The Sync Gateway sync function is where a
  server can reject a write: `throw({forbidden: ...})` rejects the update with
  HTTP 403, "the preferred way to reject an update" [N41]. The docs say
  client-side validation should prevent invalid documents and server validation
  "should be seen as a fail-safe" [N41].
- A Couchbase developer tutorial puts `_type` and `_schema` metadata in each
  document, reads fields through accessors, and runs ordered `migrate()` steps
  when a document is loaded [N42]. It offers "at request time migration" or a
  mass migration [N42]. It does not show writing the upgraded document back and
  does not discuss old app versions [N42].
- I found no official Couchbase page on what an old Couchbase Lite client does
  with documents in a newer shape. See Gaps.

## B. Local-first systems and old clients

### Replicache

- `schemaVersion` is an app-defined string option. It "enables versioning of
  mutators (in the push direction) and the client view (in the pull direction)"
  [N43]. It is sent in every `PushRequest` and `PullRequest` [N43][N46].
- The launch checklist says "you will almost certainly wish to change the
  schema" of mutations and client views, and recommends setting `schemaVersion`
  from the start [N46]. Changing a mutator's arguments requires a new mutator
  name, because "Replicache does not handle mutator versioning" [N46].
- The server may answer `VersionNotSupported` with `versionType` of `pull`,
  `push` or `schema` [N45][N47]. It may answer `ClientStateNotFound` when it has
  lost the client's state [N47]. A pull can also return a `clear` patch and
  rebuild the client view from scratch [N47].
- On `VersionNotSupported`, Replicache calls `onUpdateNeeded`. The default
  reloads the page with `location.reload()`; an app can show a toast instead
  [N45].
- Local storage is versioned by name. The IndexedDB name is
  `rep:{name}:{formatVersion}:{schemaVersion}` [N44]. A new schema version
  therefore starts a fresh local database and re-pulls. There is no client-side
  data migration API in Replicache.
- Tabs talk to each other. A tab that opens with a new IndexedDB name broadcasts
  it; older tabs with a different name call `onUpdateNeeded` [N44][N45]. Old
  tabs learn about new code from a new tab, not only from the server.

### Rocicorp Zero

- Zero derives Replicache's `schemaVersion` from a hash of the client schema
  plus a storage version [N50]. The full client schema is sent on the first
  connection and stored with the server's client view record [N50].
- `zero-cache` checks compatibility structurally [N49]. Every table the client
  knows must be replicated. Every client column must exist with the same type.
  The primary key must match a non-null unique index. Extra server tables and
  columns are fine. Any violation throws `SchemaVersionNotSupported` with a
  message listing each problem [N49].
- On that error the client disables its client group and calls `onUpdateNeeded`
  with reason `SchemaVersionNotSupported` [N50]. The default reloads the page
  [N48].
- The schema-changes guide gives the deploy order [N48]:
  - Expand: "Deploy providers before consumers. DB → API → Client." Wait for the
    change to replicate and for any backfill before deploying the API.
  - Contract: "Deploy consumers before providers. Client → API → DB."
  - Compound changes such as renames: expand (add new column, optional backfill
    and sync trigger), then contract (remove the old one).
- Backfill gate. When Zero sees a new column, it backfills the replica in the
  background, and "the new column is not exposed to the client until all data
  has been backfilled" [N48]. Code that uses the column before then fails [N48].

### ElectricSQL

- When a table used by a shape gains, loses or renames a column, "Electric
  automatically invalidates all shapes on that table" [N51]. Detection comes
  from Postgres relation messages plus a check every 60 seconds [N51].
- Clients receive `409 Conflict` or a `must-refetch` control message, discard
  local data and re-sync the shape [N51]. Dropped tables need manual shape
  deletion, because Postgres does not stream DDL on logical replication [N51].
- Shape definitions are immutable. Changing the data means a new subscription
  [N51].

### Convex and old clients

- "Schema must always match existing data. Convex enforces this constraint"
  [N52]. Safe schema changes are the expand/contract sequences: add optional,
  fill all documents, make required; mark optional, remove from all documents,
  remove [N52].
- "Functions should be backwards compatible ... your users might still be
  running the old version of your website when your backend changes" [N52]. Safe
  changes: new functions, a new optional argument, making an argument optional
  or a union with a new type [N52].
- Scheduled functions run the currently deployed version with the arguments
  stored when they were scheduled, so new code must accept old arguments [N52].
  Each migration batch chained with `scheduler.runAfter` [P14] falls under this
  rule.
- The Convex browser client puts only its npm version in the sync URL and the
  `Convex-Client` header [N53]. I found no app schema version and no
  update-needed hook in the client.
- `npx convex function-spec` lists function arguments and return values for a
  deployment, as JSON with `--file` [N54]. It could feed a CI diff for backwards
  compatibility. I did not test its output format.

## C. Comparison

| System                       | Fresh baseline                                                          | Series and waiting                                  | Failure and resume                                          | Verification                                                            | Readiness gate                                    | Derived rebuild                        | Pruning                                | Observability                        | Testability                                 |
| ---------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------- | -------------------------------------- | ------------------------------------ | ------------------------------------------- |
| MongoDB pattern [N1][N2][N3] | Not covered                                                             | None, app-driven                                    | App-driven                                                  | `constraint` scan at 9.0 [N3]                                           | App reads every version                           | Not covered                            | Drop old branch in code                | None                                 | None                                        |
| Mongock [N4]-[N19]           | Legacy import with count check [N9]; no "mark done" in open source docs | Ordered units at app startup, blocks the start [N5] | Resume from failed unit [N5]; append-only states [N14][N15] | Count check on legacy import [N9]                                       | `systemVersion` window [N6]; 2-stage advice [N4]  | `runAlways` units [N13]                | Not covered                            | Start, success, failure events [N12] | Test base resets history [N11]              |
| migrate-mongo [N20]-[N24]    | None                                                                    | CLI returns when done [N20]                         | Stops at first failure, reports done list [N20]             | Optional file hash triggers re-run [N21]                                | None                                              | Re-run via hash only [N23]             | Delete file, row ignored [N21]         | `status` table [N21]                 | None built in                               |
| Prisma + Mongo [N25]         | `db push` for indexes                                                   | None                                                | None                                                        | CI check for breaking changes [N25]                                     | Optional fields, read defaults [N25]              | None                                   | None                                   | None                                 | None                                        |
| fireway [N29]                | None                                                                    | CLI runs in order                                   | Fails closed on last failure [N29]                          | Checksum stored, unused [N29]                                           | None                                              | None                                   | Below high-water mark is ignored [N29] | Write counters [N29]                 | `--dryrun`, emulator [N29]                  |
| DynamoDB [N30]-[N36]         | None                                                                    | Step Functions map [N31]                            | Redrive reprocesses items [N31]                             | Violation Detector after GSI backfill [N35]; failed-record report [N36] | GSI `CREATING` to `ACTIVE` [N35]                  | Scan plus Streams catch-up [N33]       | None                                   | Processed and failed counts [N36]    | None                                        |
| Realm [N37]-[N40]            | New realm starts at current version                                     | Runs on open                                        | Throws on lower version [N37]                               | None                                                                    | Additive-only for sync [N39]                      | Partner collection with triggers [N40] | Not covered                            | None                                 | `deleteRealmIfMigrationNeeded` in dev [N37] |
| Replicache [N43]-[N47]       | New IDB per `schemaVersion` [N44]                                       | N/A                                                 | `ClientStateNotFound`, `clear` patch [N47]                  | N/A                                                                     | `VersionNotSupported` then `onUpdateNeeded` [N45] | Full re-pull [N44][N47]                | N/A                                    | N/A                                  | N/A                                         |
| Zero [N48]-[N50]             | N/A                                                                     | Deploy order rules [N48]                            | Disable client group, reload [N50]                          | Structural subset check [N49]                                           | Column hidden until backfilled [N48]              | Client re-sync                         | N/A                                    | Error lists each mismatch [N49]      | Staging advised [N48]                       |
| Electric [N51]               | N/A                                                                     | N/A                                                 | `must-refetch` [N51]                                        | N/A                                                                     | N/A                                               | Shape invalidation, re-sync [N51]      | Manual shape delete [N51]              | N/A                                  | N/A                                         |

N/A means the concept does not apply to a sync engine. "Not covered" means the
source is silent.

## Best ideas for a Convex migration component

Ranked by how directly they fix the problem statement's problems under Convex
constraints: no DDL, about 4096 documents and 1 second per mutation [P26],
schema validated against every document on push [N52], rolling deploys with old
clients [N52], components with isolated tables.

1. **Record state in the same transaction as the work, and keep an append-only
   history.** Mongock's derived "latest relevant state" model [N14][N15] beats a
   single mutable row because it keeps every failed and rolled-back attempt.
   Mongock and migrate-mongo both write history separately from the work and can
   lose the record [N13][N20]. A Convex batch mutation can write the documents,
   the cursor and the history entry atomically. A failing mutation rolls back,
   so recording a first-batch failure needs a separate write. My inference is
   that this separate write is the fix for upstream issue #5 [P14].
2. **Import existing status with a count check, and allow "mark applied".**
   Mongock's legacy migration maps another tool's history and throws if the
   imported count differs from an expected number [N9]. A Convex component that
   replaces `@convex-dev/migrations` should read the old component's status rows
   (names with `isDone`) and import them, with an expected count. Combined with
   Prisma-style `resolve --applied` [P6], this removes the 98-entry replay
   without running anything.
3. **Separate "run once" from "run every time".** Mongock's `runAlways` units
   run on every start but are recorded once [N13]. That is the right home for
   idempotent seeds and readiness defaults. Derived-data rebuilds need a third
   kind that ignores done state. Electric and Replicache treat derived state as
   disposable and rebuild it from source when its version changes [N44][N51].
   Firestore imports skip Cloud Functions [N28], and Convex imports skip
   triggers [P30]. A rebuild kind keyed by a "derivation version" instead of
   migration history matches all of these sources. The version key is my
   inference.
4. **Gate readers on platform-computed readiness, not on app flags.** DynamoDB
   will not serve a new index until backfill finishes [N35]. Zero hides a new
   column until backfill finishes [N48]. The component should expose
   `isReady(name)` from its own state, true when the migration is done or was
   baselined. On a fresh deployment the baseline marks it done, so no
   flag-flipping migration is needed. That solves problem 3.
5. **Publish deploy order as part of the API, and gate the contract step on old
   clients being gone.** Zero's rule is expand DB, API, client; contract client,
   API, DB [N48]. Realm says remove from clients first and keep the server field
   [N39]. In Convex the "DB" contract is a schema push, which fails until no
   document has the old shape [N52]. So a contract train needs three ordered
   steps: stop old writers (old clients and old scheduled jobs [N52]), clear the
   field with a migration, then narrow the schema. Convex sends no app version
   from the client [N53]. The component cannot detect old tabs by itself. An
   optional app-supplied build id, checked by a query that returns "update
   needed", would copy Replicache and Zero [N45][N50]. That design is inference.
6. **Make every batch a predicate-driven no-op on already-migrated documents.**
   The MongoDB pattern marks each document with its version [N1][N2]. DynamoDB
   writes guarded by a version condition make a re-run a no-op [N36]. Redrives
   reprocess items, so AWS requires idempotent updates [N31]. Each Convex
   migration should declare the "old shape" predicate. That predicate makes
   reruns safe and doubles as the verifier.
7. **Verify before finalize.** DynamoDB runs a violation detector after backfill
   [N35]. Mongock checks imported counts [N9]. Zero lists every mismatch instead
   of a generic error [N49]. The component should run the "old shape" predicate
   as a paginated count before marking done or allowing the contract step. It
   should report the count and sample ids. Checksums matter less.
   migrate-mongo's hash re-runs changed files and forces every script to be
   re-runnable [N23]. fireway stores a checksum and never checks it [N29].
   Record a code hash for audit only.
8. **Use set semantics by name, not a high-water mark.** fireway silently skips
   any migration whose version is below the latest applied one [N29]. Two
   branches that each add a migration would lose one. Mongock and migrate-mongo
   match by identity [N13][N21].
9. **Fail visibly and resume from the failed step.** Mongock resumes from the
   failed unit [N5]. fireway refuses to run until an operator clears the failure
   [N29]. For a Convex series, the CLI entry point should run in an action, wait
   for each migration, and exit non-zero with the failed name and error. Problem
   2 asks for exactly that. Each later run resumes from the stored cursor.
10. **Hold a lease lock inside a mutation, and re-check under the lock.**
    Mongock acquires a leased lock, then reloads history before running
    [N7][N16]. migrate-mongo's check-then-insert lock races and is off by
    default [N22]. Convex mutations are serializable [N55], so a lock row read
    and written in one mutation is atomic. The lease covers a crashed action.
11. **Migrate the component's own tables with its own mechanism.** Mongock's
    system update runs `@SystemChange` units on its history collection before
    user migrations [N16][N17]. A Convex component's tables are also validated
    on push. Its own schema changes need the same expand/contract rules, and a
    system-update step is the precedent.
12. **Dry run with write counters, and test helpers that reset state.**
    fireway's dry run blocks commits and counts each write type [N29]. Mongock's
    test base resets history between tests [N11]. With convex-test, the
    component should offer a dry run that rolls back and reports counts, plus a
    helper that runs a whole series to completion in one test.
13. **Treat pruning as deleting the definition.** migrate-mongo ignores
    changelog rows whose file is gone [N21]. With a baseline (idea 2) and set
    semantics (idea 8), removing a finished migration from code should be safe.
    Status should show orphaned rows the way Rails shows `NO FILE` [P1].

## Gaps

- The Couchbase forum thread "Document schema versioning and sync gateway"
  returned HTTP 403 to automated fetches. Search summaries attribute old-client
  guidance to a Couchbase reply there. I did not verify it and did not cite it.
- I found no official Couchbase Lite page on schema versions or on old clients
  reading newer documents. The Couchbase material above is the sync function
  reference [N41] and a generic tutorial [N42].
- Google publishes no Firestore schema migration tool. fireway is archived; I
  did not survey its forks.
- The Cost-effective bulk processing post [N32] was cut off in the fetch. Its
  shuffled-scan and resume details are unverified.
- The Mongock docs list PRO operations [N10] that I could not inspect in the
  open source code. I did not find a "mark as executed without running"
  operation in the open source docs.
- Mongock development appears to continue as Flamingock. I did not research
  Flamingock.
- The Realm and App Services docs are for deprecated or end-of-life products
  [N37][N39]. They describe the design, not a maintained product.
- MongoDB's `constraint` validation level is new in 9.0 per the page [N3]. I did
  not test it.
- The Firestore Pipeline DML page does not say whether the feature is preview or
  GA [N27].
- `npx convex function-spec` output was not inspected [N54].
- I did not check whether the Convex client exposes any deploy or version event
  outside `src/browser/sync` [N53].
- Ideas 3, 4 and 5 contain design inference beyond the sources. They are marked
  in the text.

## Sources

- N1. MongoDB Manual, Maintain Different Schema Versions:
  https://www.mongodb.com/docs/manual/data-modeling/design-patterns/data-versioning/schema-versioning/
- N2. MongoDB Blog, Building with Patterns: The Schema Versioning Pattern (Ken
  W. Alger, Daniel Coupal, 2019-04-19, updated 2019-07-12):
  https://www.mongodb.com/blog/post/building-with-patterns-the-schema-versioning-pattern
- N3. MongoDB Manual 9.0, Specify Validation Level for Existing Documents:
  https://www.mongodb.com/docs/manual/core/schema-validation/specify-validation-level/
- N4. Mongock docs v5, Migration (ChangeUnit methods, attributes, best
  practices): https://docs.mongock.io/v5/migration/index.html (source:
  flamingock/mongock-docs@e49c8b6 `site/v5/migration/migration.md` lines 34-58,
  62-71, 125-148)
- N5. Mongock docs v5, Technical overview, Mongock process:
  https://docs.mongock.io/v5/technical-overview/index.html
  (`site/v5/technical-overview/technical-overview.md` lines 51-70, section
  "Mongock process")
- N6. Mongock docs v5, Runner configuration:
  https://docs.mongock.io/v5/runner/index.html (`site/v5/runner/runner.md` lines
  48, 55-70)
- N7. Mongock docs v5, Driver (lock settings):
  https://docs.mongock.io/v5/driver/index.html (`site/v5/driver/driver.md` lines
  44-47)
- N8. Mongock docs v5, Transactions:
  https://docs.mongock.io/v5/features/transactions/index.html
- N9. Mongock docs v5, Legacy migration:
  https://docs.mongock.io/v5/features/legacy-migration/index.html
  (`site/v5/features/features-legacy-migration.md` lines 18-90)
- N10. Mongock docs v5, CLI operations:
  https://docs.mongock.io/v5/cli/operations/index.html
- N11. Mongock docs v5, Testing: https://docs.mongock.io/v5/testing/index.html
- N12. Mongock docs v5, Events:
  https://docs.mongock.io/v5/features/events/index.html
  (`site/v5/features/features-events.md` lines 22-26)
- N13. flamingock/mongock `mongock-5.5.1` (70643af),
  `mongock-core/mongock-runner/mongock-runner-core/src/main/java/io/mongock/runner/core/executor/ChangeExecutorBase.java`
  lines 220-278:
  https://github.com/flamingock/mongock/blob/70643afce114aec18c4483bc9d08de469f1f944a/mongock-core/mongock-runner/mongock-runner-core/src/main/java/io/mongock/runner/core/executor/ChangeExecutorBase.java#L220-L278
- N14. Same tag,
  `mongock-core/mongock-driver/mongock-driver-api/src/main/java/io/mongock/driver/api/entry/ChangeEntryService.java`
  lines 37-49:
  https://github.com/flamingock/mongock/blob/70643afce114aec18c4483bc9d08de469f1f944a/mongock-core/mongock-driver/mongock-driver-api/src/main/java/io/mongock/driver/api/entry/ChangeEntryService.java#L37-L49
- N15. Same tag, `.../driver/api/entry/ChangeState.java` lines 3-9:
  https://github.com/flamingock/mongock/blob/70643afce114aec18c4483bc9d08de469f1f944a/mongock-core/mongock-driver/mongock-driver-api/src/main/java/io/mongock/driver/api/entry/ChangeState.java
- N16. Same tag, `.../executor/operation/migrate/MigrateExecutorBase.java` lines
  45-73 and `.../executor/system/SystemUpdateExecutor.java` lines 55-111:
  https://github.com/flamingock/mongock/blob/70643afce114aec18c4483bc9d08de469f1f944a/mongock-core/mongock-runner/mongock-runner-core/src/main/java/io/mongock/runner/core/executor/system/SystemUpdateExecutor.java#L55-L111
- N17. Same tag, `.../executor/system/changes/SystemChangeUnit00001.java` lines
  18-46:
  https://github.com/flamingock/mongock/blob/70643afce114aec18c4483bc9d08de469f1f944a/mongock-core/mongock-runner/mongock-runner-core/src/main/java/io/mongock/runner/core/executor/system/changes/SystemChangeUnit00001.java
- N18. Same tag,
  `mongock-core/mongock-api/src/main/java/io/mongock/api/annotations/ChangeUnit.java`
  lines 10-115:
  https://github.com/flamingock/mongock/blob/70643afce114aec18c4483bc9d08de469f1f944a/mongock-core/mongock-api/src/main/java/io/mongock/api/annotations/ChangeUnit.java
- N19. Same tag, `.../executor/MongockRunnerImpl.java` lines 51-70:
  https://github.com/flamingock/mongock/blob/70643afce114aec18c4483bc9d08de469f1f944a/mongock-core/mongock-runner/mongock-runner-core/src/main/java/io/mongock/runner/core/executor/MongockRunnerImpl.java#L51-L70
- N20. seppevs/migrate-mongo `v14.0.7` (1f5e5f9), `lib/actions/up.js` lines
  6-59:
  https://github.com/seppevs/migrate-mongo/blob/1f5e5f953491042ea1c9d607ba71a4b264e0b611/lib/actions/up.js
- N21. Same tag, `lib/actions/status.js` lines 4-32:
  https://github.com/seppevs/migrate-mongo/blob/1f5e5f953491042ea1c9d607ba71a4b264e0b611/lib/actions/status.js
- N22. Same tag, `lib/utils/lock.js` lines 3-36:
  https://github.com/seppevs/migrate-mongo/blob/1f5e5f953491042ea1c9d607ba71a4b264e0b611/lib/utils/lock.js
- N23. Same tag, `samples/esm/migrate-mongo-config.js` lines 22-36 and
  `README.md` lines 321-370 (transactions, file hash):
  https://github.com/seppevs/migrate-mongo/blob/1f5e5f953491042ea1c9d607ba71a4b264e0b611/README.md
- N24. Same tag, `lib/actions/down.js` lines 6-63:
  https://github.com/seppevs/migrate-mongo/blob/1f5e5f953491042ea1c9d607ba71a4b264e0b611/lib/actions/down.js
- N25. Prisma docs, MongoDB (no Migrate, `db push`, data migration strategies):
  https://www.prisma.io/docs/orm/overview/databases/mongodb
- N26. Firebase, Best practices for Cloud Firestore (migrating traffic to a new
  collection, 500/50/5):
  https://firebase.google.com/docs/firestore/best-practices
- N27. Firebase, Modify data with Firestore Pipeline operations (DML):
  https://firebase.google.com/docs/firestore/pipelines/dml
- N28. Firebase, Export and import data (import does not trigger Cloud
  Functions):
  https://firebase.google.com/docs/firestore/manage-data/export-import
- N29. kevlened/fireway `1.1.0` (884c78b, repository archived), `src/index.js`
  lines 28-40 (dry run), 300-385 (state and execution) and `README.md` lines 63,
  130-155:
  https://github.com/kevlened/fireway/blob/884c78b9d55239b877f33acf1173dfc0a99c96d3/src/index.js
- N30. AWS Database Blog, Evolve your Amazon DynamoDB table's data model
  (Imhoertha Ojior, 2025-07-10):
  https://aws.amazon.com/blogs/database/evolve-your-amazon-dynamodb-tables-data-model/
- N31. AWS Database Blog, Bulk update Amazon DynamoDB tables with AWS Step
  Functions (Chris Gillespie, 2024-03-20):
  https://aws.amazon.com/blogs/database/bulk-update-amazon-dynamodb-tables-with-aws-step-functions/
- N32. AWS Database Blog, Cost-effective bulk processing with Amazon DynamoDB
  (Jason Hunter, 2023-05-30):
  https://aws.amazon.com/blogs/database/cost-effective-bulk-processing-with-amazon-dynamodb/
- N33. AWS DynamoDB Developer Guide, Scanning tables (pagination, read
  consistency, parallel scan):
  https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html
- N34. AWS DynamoDB Developer Guide, Change data capture for DynamoDB Streams:
  https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html
- N35. AWS DynamoDB Developer Guide, Managing global secondary indexes (phases,
  backfill, violations):
  https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.OnlineOps.html
- N36. AWS Database Blog, Introducing bulk put items for Amazon DynamoDB (Lee
  Hannigan, Anugrah Prakash, 2026-11-05):
  https://aws.amazon.com/blogs/database/introducing-bulk-put-items-for-amazon-dynamodb-load-data-from-amazon-s3-into-existing-tables-at-scale/
- N37. MongoDB, Atlas Device SDK for Node.js, Change an Object Model:
  https://www.mongodb.com/docs/atlas/device-sdks/sdk/node/model-data/modify-an-object-schema/
  (markdown: same URL with `.md`)
- N38. MongoDB, Atlas Device SDK for Swift, Change an Object Model:
  https://www.mongodb.com/docs/atlas/device-sdks/sdk/swift/model-data/change-an-object-model/
- N39. MongoDB, Atlas App Services, Update Your Data Model (synced schema
  changes):
  https://www.mongodb.com/docs/atlas/app-services/sync/data-model/update-schema/
- N40. MongoDB, Atlas App Services, Make Breaking Schema Changes (partner
  collections):
  https://www.mongodb.com/docs/atlas/app-services/sync/data-model/migrate-schema-partner-collection/
- N41. Couchbase Sync Gateway docs, Sync Function:
  https://docs.couchbase.com/sync-gateway/current/sync-function.html
- N42. Couchbase Developer Portal, Tutorial: Schema Versioning:
  https://developer.couchbase.com/tutorial-schema-versioning/
- N43. rocicorp/mono `zero/v1.11.4` (be94346),
  `packages/replicache/src/replicache-options.ts` lines 64-69,
  `src/sync/push.ts` lines 58-70, `src/sync/pull.ts` lines 61-70:
  https://github.com/rocicorp/mono/blob/be94346faaf4ee7e7b2cf983f6e5accae3a6b4fb/packages/replicache/src/replicache-options.ts#L64-L69
- N44. Same tag, `packages/replicache/src/make-idb-name.ts` lines 10-21 and
  `src/new-client-channel.ts` lines 40-100:
  https://github.com/rocicorp/mono/blob/be94346faaf4ee7e7b2cf983f6e5accae3a6b4fb/packages/replicache/src/new-client-channel.ts#L40-L100
- N45. Same tag, `packages/replicache/src/replicache.ts` lines 232-256,
  `src/types.ts` lines 74-88, `src/error-responses.ts` lines 32-58:
  https://github.com/rocicorp/mono/blob/be94346faaf4ee7e7b2cf983f6e5accae3a6b4fb/packages/replicache/src/replicache.ts#L232-L256
- N46. Replicache docs, Launch to Production:
  https://doc.replicache.dev/howto/launch
- N47. Replicache docs, Pull Endpoint Reference:
  https://doc.replicache.dev/reference/server-pull
- N48. Zero docs, Schema, section "Schema Changes":
  https://zero.rocicorp.dev/docs/schema
- N49. rocicorp/mono `zero/v1.11.4`,
  `packages/zero-cache/src/services/view-syncer/client-schema.ts` lines 16-141:
  https://github.com/rocicorp/mono/blob/be94346faaf4ee7e7b2cf983f6e5accae3a6b4fb/packages/zero-cache/src/services/view-syncer/client-schema.ts#L16-L141
- N50. Same tag, `packages/zero-client/src/client/zero.ts` lines 641-662
  (schemaVersion hash), 1640-1655 (error handling), 1760-1772 (client schema on
  connect):
  https://github.com/rocicorp/mono/blob/be94346faaf4ee7e7b2cf983f6e5accae3a6b4fb/packages/zero-client/src/client/zero.ts#L641-L662
- N51. ElectricSQL docs, Shapes (schema changes, shape deletion, immutability):
  https://electric.ax/docs/guides/shapes
- N52. Convex docs, Deploying Your App to Production, "Making safe changes":
  https://docs.convex.dev/production
- N53. get-convex/convex-js `npm/1.49.0` (58c383e), `src/browser/sync/client.ts`
  lines 339 and 1112:
  https://github.com/get-convex/convex-js/blob/58c383e46f9984eeea6105e0ba7fe94b2a3db1b5/src/browser/sync/client.ts#L339
- N54. Convex docs, `npx convex function-spec`:
  https://docs.convex.dev/cli/reference/function-spec
- N55. Convex docs, OCC and Atomicity ("Snapshot Isolation vs Serializability"):
  https://docs.convex.dev/database/advanced/occ
