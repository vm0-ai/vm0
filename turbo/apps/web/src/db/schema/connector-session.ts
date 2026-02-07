import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  pgEnum,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const connectorSessionStatusEnum = pgEnum("connector_session_status", [
  "pending",
  "complete",
  "expired",
  "error",
]);

/**
 * Connector sessions table
 * Used for CLI device flow - tracks pending OAuth connections
 * Similar pattern to device_codes table for CLI auth
 */
export const connectorSessions = pgTable(
  "connector_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: varchar("code", { length: 9 }).notNull(), // XXXX-XXXX format
    type: varchar("type", { length: 50 }).notNull(), // "github"
    userId: text("user_id").notNull(), // Clerk user ID (CLI is already logged in)
    status: connectorSessionStatusEnum("status").default("pending").notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    uniqueIndex("idx_connector_sessions_code").on(table.code),
    index("idx_connector_sessions_user_status").on(table.userId, table.status),
  ],
);
