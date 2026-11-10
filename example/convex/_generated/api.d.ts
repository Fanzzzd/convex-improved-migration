/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as demo from "../demo.js";
import type * as migrations from "../migrations.js";
import type * as testing_altPlan from "../testing/altPlan.js";
import type * as testing_fakeUpstream from "../testing/fakeUpstream.js";
import type * as testing_laps from "../testing/laps.js";
import type * as testing_rebuildLaps from "../testing/rebuildLaps.js";
import type * as testing_rebuildV2 from "../testing/rebuildV2.js";
import type * as testing_regressions from "../testing/regressions.js";
import type * as testing_startV1 from "../testing/startV1.js";
import type * as testing_startV2 from "../testing/startV2.js";
import type * as testing_stepwise from "../testing/stepwise.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  demo: typeof demo;
  migrations: typeof migrations;
  "testing/altPlan": typeof testing_altPlan;
  "testing/fakeUpstream": typeof testing_fakeUpstream;
  "testing/laps": typeof testing_laps;
  "testing/rebuildLaps": typeof testing_rebuildLaps;
  "testing/rebuildV2": typeof testing_rebuildV2;
  "testing/regressions": typeof testing_regressions;
  "testing/startV1": typeof testing_startV1;
  "testing/startV2": typeof testing_startV2;
  "testing/stepwise": typeof testing_stepwise;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  migration: import("convex-improved-migration/_generated/component.js").ComponentApi<"migration">;
};
