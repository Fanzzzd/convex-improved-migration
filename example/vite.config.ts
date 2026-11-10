import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
	envDir: "../",
	// `npx convex dev` writes CONVEX_URL to ../.env.local. Expose it to the
	// page, so the example runs without a hand-written VITE_CONVEX_URL.
	envPrefix: ["VITE_", "CONVEX_URL"],
	plugins: [react()],
	resolve: {
		conditions: ["@convex-dev/component-source"],
	},
});
