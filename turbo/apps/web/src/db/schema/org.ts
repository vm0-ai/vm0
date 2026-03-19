import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * org — stores per-org data that is owned by the platform (not Clerk).
 * Currently holds credit balance; Clerk remains source of truth for
 * slug, tier, and membership.
 */
export const org = pgTable("org", {
  orgId: text("org_id").primaryKey(),
  credits: bigint("credits", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
