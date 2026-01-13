import { defineConfig } from "drizzle-kit";

export const DRIZZLE_MIGRATE_OUT = "./src/db/migrations";

const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: "./src/db/schema/*",
  out: DRIZZLE_MIGRATE_OUT,
  dialect: "postgresql",
  ...(databaseUrl
    ? {
        dbCredentials: {
          url: databaseUrl,
        },
      }
    : {
        driver: "pglite",
        dbCredentials: {
          url: "./.pglite",
        },
      }),
  verbose: true,
  strict: false,
});
