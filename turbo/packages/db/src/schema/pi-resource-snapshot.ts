import { jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

import type { PiResourceSnapshot } from "@okouai/db/jsonb-contracts/pi-resource-snapshot";

/** Content-addressed Pi discovery data used by serverless first-turn slots. */
export const piResourceSnapshots = pgTable("pi_resource_snapshots", {
  digest: varchar("digest", { length: 64 }).primaryKey(),
  snapshot: jsonb("snapshot").$type<PiResourceSnapshot>().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
