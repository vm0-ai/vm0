import { bigint, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * org_metadata — stores per-org data that is owned by the platform (not Clerk).
 * Holds credit balance, tier, and default agent configuration.
 * Clerk remains source of truth for slug and membership only.
 */
export const orgMetadata = pgTable("org_metadata", {
  orgId: text("org_id").primaryKey(),
  credits: bigint("credits", { mode: "number" }).notNull().default(0),
  tier: text("tier").notNull().default("free"),
  defaultAgentComposeId: uuid("default_agent_compose_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
