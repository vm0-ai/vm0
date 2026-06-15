import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { telegramInstallations } from "./telegram-installation";
import { telegramOfficialUserLinks } from "./telegram-official-user-link";

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
  custom_emoji_id?: string;
  user?: {
    id: number;
    is_bot?: boolean;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
}

/**
 * Telegram Messages table
 * Stores messages received by the bot for context retrieval.
 * Telegram Bot API has no history API, so we must store messages ourselves.
 * Messages are retained for 30 days (cleaned up by cron job).
 */
export const telegramMessages = pgTable(
  "telegram_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installationId: varchar("installation_id", { length: 255 }).references(
      () => {
        return telegramInstallations.telegramBotId;
      },
      { onDelete: "cascade" },
    ),
    officialOrgId: text("official_org_id"),
    officialUserLinkId: uuid("official_user_link_id").references(
      () => {
        return telegramOfficialUserLinks.id;
      },
      { onDelete: "set null" },
    ),
    chatId: varchar("chat_id", { length: 255 }).notNull(),
    messageId: varchar("message_id", { length: 255 }).notNull(),
    fromUserId: varchar("from_user_id", { length: 255 }).notNull(),
    fromUsername: varchar("from_username", { length: 255 }),
    fromDisplayName: varchar("from_display_name", { length: 255 }),
    text: text("text"),
    /** Telegram file_id for downloadable attachments — used for context downloads */
    fileId: varchar("file_id", { length: 255 }),
    fileType: varchar("file_type", { length: 32 }),
    fileName: text("file_name"),
    fileMimeType: varchar("file_mime_type", { length: 255 }),
    fileSize: integer("file_size"),
    fileWidth: integer("file_width"),
    fileHeight: integer("file_height"),
    fileDuration: integer("file_duration"),
    entities: jsonb("entities").$type<TelegramMessageEntity[]>(),
    isBot: boolean("is_bot").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // Each message is unique per installation + chat + message ID
      uniqueIndex("idx_telegram_messages_unique")
        .on(table.installationId, table.chatId, table.messageId)
        .where(sql`installation_id IS NOT NULL`),
      uniqueIndex("idx_telegram_messages_official_unique")
        .on(table.officialOrgId, table.chatId, table.messageId)
        .where(sql`official_org_id IS NOT NULL`),
      // Index for context queries (recent messages in a chat)
      index("idx_telegram_messages_chat")
        .on(table.installationId, table.chatId)
        .where(sql`installation_id IS NOT NULL`),
      index("idx_telegram_messages_official_chat")
        .on(table.officialOrgId, table.chatId)
        .where(sql`official_org_id IS NOT NULL`),
      // Index for 30-day cleanup cron
      index("idx_telegram_messages_created_at").on(table.createdAt),
      check(
        "chk_telegram_messages_one_owner",
        sql`(installation_id IS NOT NULL) <> (official_org_id IS NOT NULL)`,
      ),
    ];
  },
);
