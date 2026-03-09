import { pgTable, uuid, varchar, text, timestamp } from "drizzle-orm/pg-core";
import { agentComposes } from "./agent-compose";

/**
 * Telegram Installations table
 * Stores bot-level tokens and default agent for Telegram bot integrations
 * One record per Telegram bot. Each bot has exactly one default agent.
 */
export const telegramInstallations = pgTable("telegram_installations", {
  id: uuid("id").defaultRandom().primaryKey(),
  telegramBotId: varchar("telegram_bot_id", { length: 255 }).notNull().unique(),
  botUsername: varchar("bot_username", { length: 255 }),
  // Bot token encrypted with AES-256-GCM
  encryptedBotToken: text("encrypted_bot_token").notNull(),
  // Secret token for webhook verification (X-Telegram-Bot-Api-Secret-Token)
  webhookSecret: varchar("webhook_secret", { length: 255 }).notNull(),
  // Bot default agent — always set at registration time
  defaultComposeId: uuid("default_compose_id")
    .notNull()
    .references(() => agentComposes.id, { onDelete: "cascade" }),
  // Admin: the VM0 user who registered the bot (Clerk user ID)
  adminUserId: text("admin_user_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
