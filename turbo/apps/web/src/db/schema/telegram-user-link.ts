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
 * Maps Telegram users to VM0 users for account linking.
 * Allows users to interact with VM0 agents via Telegram.
 */
export const telegramUserLinks = pgTable(
  "telegram_user_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    telegramUserId: varchar("telegram_user_id", { length: 255 }).notNull(),
    installationId: varchar("installation_id", { length: 255 })
      .notNull()
      .references(
        () => {
          return telegramInstallations.telegramBotId;
        },
        { onDelete: "cascade" },
      ),
    // VM0 user ID (Clerk user ID)
    vm0UserId: text("vm0_user_id").notNull(),
    dmWelcomeSent: boolean("dm_welcome_sent").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // Each Telegram user can only link to one VM0 user per bot
      uniqueIndex("idx_telegram_user_links_user_installation").on(
        table.telegramUserId,
        table.installationId,
      ),
    ];
  },
);
