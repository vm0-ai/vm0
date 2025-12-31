import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Runners table
 * Represents self-hosted runners that can execute agent runs
 * Runners authenticate via CLI tokens (same as CLI) and register with a group
 */
export const runners = pgTable(
  "runners",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(), // Clerk user ID - owner of this runner
    name: varchar("name", { length: 255 }).notNull(), // Runner name (e.g., "ci-runner-1")
    runnerGroup: varchar("runner_group", { length: 255 }).notNull(), // Group in scope/name format (e.g., "acme/production")
    status: varchar("status", { length: 20 }).default("offline").notNull(), // online, offline, busy
    lastHeartbeatAt: timestamp("last_heartbeat_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // A user can only have one runner with the same name
    unique("runners_user_id_name_unique").on(table.userId, table.name),
  ],
);
