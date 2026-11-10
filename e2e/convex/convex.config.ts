import { defineApp } from "convex/server";
import migration from "convex-improved-migration/convex.config.js";

const app = defineApp();
app.use(migration, { name: "migration" });
export default app;
