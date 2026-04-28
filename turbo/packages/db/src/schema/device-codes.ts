import {
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const deviceCodeStatusEnum = pgEnum("device_code_status", [
  "pending",
  "authenticated",
  "approved",
  "consumed",
  "expired",
  "denied",
]);

export const deviceCodes = pgTable("device_codes", {
  code: varchar("code", { length: 9 }).primaryKey(), // XXXX-XXXX format
  purpose: varchar("purpose", { length: 32 }).default("cli").notNull(),
  status: deviceCodeStatusEnum("status").default("pending").notNull(),
  userId: text("user_id"), // Clerk user ID, set after authentication
  orgId: text("org_id"), // Org ID from browser session, set on approval
  bleSessionNonce: text("ble_session_nonce"),
  pollTokenHash: text("poll_token_hash"),
  pollIntervalSeconds: integer("poll_interval_seconds"),
  cliTokenId: uuid("cli_token_id"),
  chatThreadId: uuid("chat_thread_id"),
  approvedAt: timestamp("approved_at"),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
