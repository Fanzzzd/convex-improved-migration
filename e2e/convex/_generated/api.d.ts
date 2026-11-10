/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as burst from "../burst.js";
import type * as busy from "../busy.js";
import type * as data from "../data.js";
import type * as long from "../long.js";
import type * as migrations from "../migrations.js";
import type * as paginate from "../paginate.js";
import type * as slow from "../slow.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  burst: typeof burst;
  busy: typeof busy;
  data: typeof data;
  long: typeof long;
  migrations: typeof migrations;
  paginate: typeof paginate;
  slow: typeof slow;
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
