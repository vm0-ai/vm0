import { pgTable, varchar, timestamp, text, pgEnum } from "drizzle-orm/pg-core";

export const deviceCodeStatusEnum = pgEnum("device_code_status", [
  "pending",
  "authenticated",
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
