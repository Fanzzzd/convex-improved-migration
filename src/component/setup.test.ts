/// <reference types="vite/client" />
import { test } from "vitest";
import schema from "./schema.js";
import { convexTest } from "convex-test";
import { SHORT_SENTINEL_FLAG } from "../shared.js";
export const modules = import.meta.glob("./**/*.*s");

export function initConvexTest() {
	(globalThis as Record<string, unknown>)[SHORT_SENTINEL_FLAG] = true;
	const t = convexTest(schema, modules);
	return t;
}
test("setup", () => {});
