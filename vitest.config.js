import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	// Tests import the package by name. Point the client at the source, so a
	// stale dist/ build cannot hide a client bug.
	resolve: {
		alias: [
			{
				find: /^convex-improved-migration$/,
				replacement: fileURLToPath(
					new URL("./src/client/index.ts", import.meta.url),
				),
			},
		],
	},
	test: {
		environment: "edge-runtime",
		typecheck: {
			tsconfig: "./tsconfig.test.json",
		},
	},
});
