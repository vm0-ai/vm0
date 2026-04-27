import { defineConfig } from "drizzle-kit";

export const DRIZZLE_MIGRATE_OUT = "./src/db/migrations";

export default defineConfig({
  schema: "../../packages/db/src/schema/*",
  out: DRIZZLE_MIGRATE_OUT,
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: false,
});
