import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Official Telegram bot user links.
 *
 * The shared Zero bot is global: one Telegram user can connect to exactly one
 * internal account/org at a time. To reconnect somewhere else, they must
 * disconnect first.
 */
export const telegramOfficialUserLinks = pgTable(
  "telegram_official_user_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    telegramUserId: varchar("telegram_user_id", { length: 255 }).notNull(),
    telegramUsername: varchar("telegram_username", { length: 255 }),
    telegramDisplayName: varchar("telegram_display_name", { length: 255 }),
    userId: text("user_id").notNull(),
    // DB/API rollout fallback (observed maximum exposure: ~102 minutes).
    // Remove in #27602 after the switched API is healthy, the previous API
    // version has drained, and every transition invariant remains valid.
    legacyUserId: text("vm0_user_id").notNull(),
    orgId: text("org_id").notNull(),
    dmWelcomeSent: boolean("dm_welcome_sent").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_telegram_official_user_links_tg_user").on(
        table.telegramUserId,
      ),
      uniqueIndex("idx_telegram_official_user_links_vm0_org").on(
        table.legacyUserId,
        table.orgId,
      ),
      uniqueIndex("idx_telegram_official_user_links_user_org").on(
        table.userId,
        table.orgId,
      ),
      index("idx_telegram_official_user_links_org").on(table.orgId),
    ];
  },
);
