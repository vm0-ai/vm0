import {
  boolean,
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { telegramInstallations } from "./telegram-installation";

/**
 * Telegram User Links table
 * Maps Telegram users to internal users for account linking.
 * Allows users to interact with internal agents via Telegram.
 */
export const telegramUserLinks = pgTable(
  "telegram_user_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    telegramUserId: varchar("telegram_user_id", { length: 255 }).notNull(),
    telegramUsername: varchar("telegram_username", { length: 255 }),
    telegramDisplayName: varchar("telegram_display_name", { length: 255 }),
    installationId: varchar("installation_id", { length: 255 })
      .notNull()
      .references(
        () => {
          return telegramInstallations.telegramBotId;
        },
        { onDelete: "cascade" },
      ),
    userId: text("user_id").notNull(),
    dmWelcomeSent: boolean("dm_welcome_sent").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // Each Telegram user can only link to one internal user per bot
      uniqueIndex("idx_telegram_user_links_user_installation").on(
        table.telegramUserId,
        table.installationId,
      ),
      uniqueIndex("idx_telegram_user_links_user_id_installation").on(
        table.userId,
        table.installationId,
      ),
    ];
  },
);
