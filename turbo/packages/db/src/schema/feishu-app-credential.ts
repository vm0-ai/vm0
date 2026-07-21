import { pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const feishuAppCredentials = pgTable("feishu_app_credentials", {
  appId: varchar("app_id", { length: 255 }).notNull().primaryKey(),
  encryptedAppTicket: text("encrypted_app_ticket").notNull(),
  encryptedAppAccessToken: text("encrypted_app_access_token"),
  appAccessTokenExpiresAt: timestamp("app_access_token_expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
