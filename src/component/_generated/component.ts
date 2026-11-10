/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      adopt: FunctionReference<
        "mutation",
        "internal",
        { names: Array<string> },
        { adopted: number; alreadyDone: number; running: Array<string> },
        Name
      >;
      advance: FunctionReference<
        "mutation",
        "internal",
        {
          holder: string;
          plan: Array<{
            batchSize: number;
            clear: boolean;
            clearOnce?: boolean;
            handle: string;
            kind: "migration" | "seed" | "rebuild";
            name: string;
            oneShot: boolean;
            verify: boolean;
            version?: string;
          }>;
          runId: string;
          throttled?: { message: string; retries: number; waitedMs: number };
        },
        | { status: "done" }
        | { current: string; status: "progress" }
        | { status: "preempted" }
        | { status: "canceled" }
        | {
            failure: {
              error: {
                batch: number;
                batchSize: number;
                message: string;
                phase?: "clear" | "migrate" | "verify";
                processed: number;
              };
              kind: "migration" | "seed" | "rebuild";
              later: Array<string>;
              name: string;
            };
            status: "failed";
          },
        Name
      >;
      cancel: FunctionReference<
        "mutation",
        "internal",
        { runId?: string },
        string | null | { other: string } | { ended: true },
        Name
      >;
      continueDrive: FunctionReference<
        "mutation",
        "internal",
        {
          budgetMs: number;
          holder: string;
          plan: Array<{
            batchSize: number;
            clear: boolean;
            clearOnce?: boolean;
            handle: string;
            kind: "migration" | "seed" | "rebuild";
            name: string;
            oneShot: boolean;
            verify: boolean;
            version?: string;
          }>;
          retries?: number;
          runId: string;
          throttled?: { message: string; retries: number; waitedMs: number };
        },
        boolean,
        Name
      >;
      handOff: FunctionReference<
        "mutation",
        "internal",
        {
          budgetMs: number;
          holder: string;
          plan: Array<{
            batchSize: number;
            clear: boolean;
            clearOnce?: boolean;
            handle: string;
            kind: "migration" | "seed" | "rebuild";
            name: string;
            oneShot: boolean;
            verify: boolean;
            version?: string;
          }>;
          retries?: number;
          runId: string;
          throttled?: { message: string; retries: number; waitedMs: number };
        },
        "handed" | "canceled" | "lost",
        Name
      >;
      isReady: FunctionReference<
        "query",
        "internal",
        { name: string; version?: string },
        boolean,
        Name
      >;
      markDone: FunctionReference<
        "mutation",
        "internal",
        {
          kind: "migration" | "seed" | "rebuild";
          name: string;
          reason: string;
          version?: string;
        },
        "ok" | "running" | "done" | "import",
        Name
      >;
      prepare: FunctionReference<
        "mutation",
        "internal",
        {
          budgetMs?: number;
          mode: "read" | "foreground" | "background";
          only?: string;
          plan: Array<{
            batchSize: number;
            clear: boolean;
            clearOnce?: boolean;
            handle: string;
            kind: "migration" | "seed" | "rebuild";
            name: string;
            oneShot: boolean;
            verify: boolean;
            version?: string;
          }>;
          rebuild?: Array<string>;
          runId: string;
        },
        {
          holder: string | null;
          restored: boolean;
          unfinishedOrphans: Array<{
            name: string;
            state: "pending" | "running" | "done" | "failed";
          }>;
        },
        Name
      >;
      recordAbort: FunctionReference<
        "mutation",
        "internal",
        {
          holder: string;
          message: string;
          plan: Array<{
            batchSize: number;
            clear: boolean;
            clearOnce?: boolean;
            handle: string;
            kind: "migration" | "seed" | "rebuild";
            name: string;
            oneShot: boolean;
            verify: boolean;
            version?: string;
          }>;
          runId: string;
          throttled?: { message: string; retries: number; waitedMs: number };
        },
        | { retry: true }
        | {
            failure: {
              error: {
                batch: number;
                batchSize: number;
                message: string;
                phase?: "clear" | "migrate" | "verify";
                processed: number;
              };
              kind: "migration" | "seed" | "rebuild";
              later: Array<string>;
              name: string;
            } | null;
            retry: false;
          }
        | { retry: false; stopped: "canceled" | "preempted" },
        Name
      >;
      release: FunctionReference<
        "mutation",
        "internal",
        { holder: string; runId: string },
        null,
        Name
      >;
      reset: FunctionReference<
        "mutation",
        "internal",
        { name: string },
        "ok" | "missing" | "running",
        Name
      >;
      resume: FunctionReference<
        "mutation",
        "internal",
        { only?: string; runId: string },
        {
          ended?: {
            by?: string;
            failure?: {
              error: {
                batch: number;
                batchSize: number;
                message: string;
                phase?: "clear" | "migrate" | "verify";
                processed: number;
              };
              kind: "migration" | "seed" | "rebuild";
              later: Array<string>;
              name: string;
            };
            outcome:
              "done" | "failed" | "canceled" | "stalled" | "taken over" | null;
          };
          holder: string | null;
          restored: boolean;
          retries: number;
          scope?: { only: string | null };
          unknown?: boolean;
        },
        Name
      >;
      status: FunctionReference<
        "query",
        "internal",
        { eventsFor?: string },
        {
          events: Array<{
            at: number;
            detail: string | null;
            runId: string | null;
            type: string;
          }>;
          lease: {
            expiresAt: number;
            holder: string;
            mode: "foreground" | "background";
            runId: string;
            startedAt: number;
          } | null;
          restoreSuspected: boolean;
          rows: Array<{
            batchSize: number | null;
            batches: number;
            cursor: string | null;
            doneAt: number | null;
            error: {
              batch: number;
              batchSize: number;
              message: string;
              phase?: "clear" | "migrate" | "verify";
              processed: number;
            } | null;
            kind: "migration" | "seed" | "rebuild";
            name: string;
            notMigrated: number | null;
            phase: "clear" | "migrate" | "verify" | null;
            processed: number;
            reason: string | null;
            rebuildRequested: boolean;
            runId: string | null;
            skipped: number;
            startedAt: number | null;
            state: "pending" | "running" | "done" | "failed";
            updatedAt: number;
            verified: boolean | null;
            version: string | null;
            via: "ran" | "marked" | "adopted" | null;
          }>;
        },
        Name
      >;
    };
  };
