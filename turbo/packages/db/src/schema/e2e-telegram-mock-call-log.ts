import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Test-only log of calls made to `/api/test/telegram-mock/*` endpoints.
 *
 * Telegram e2e tests run against Vercel previews, where serverless functions
 * cannot share in-memory mock state. Persisting mock Bot API calls lets BATS
 * verify that callbacks posted the final agent reply back to Telegram.
 */
export const e2eTelegramMockCallLog = pgTable(
  "e2e_telegram_mock_call_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    method: varchar("method", { length: 64 }).notNull(),
    botToken: varchar("bot_token", { length: 255 }),
    chatId: varchar("chat_id", { length: 255 }),
    body: text("body").notNull(),
    bodyJson: jsonb("body_json"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_e2e_telegram_mock_call_log_created_at").on(table.createdAt),
      index("idx_e2e_telegram_mock_call_log_method").on(table.method),
      index("idx_e2e_telegram_mock_call_log_chat_id").on(table.chatId),
    ];
  },
);
