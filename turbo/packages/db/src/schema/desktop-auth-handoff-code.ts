import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const desktopAuthHandoffCodes = pgTable(
  "desktop_auth_handoff_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    codeHash: text("code_hash").unique().notNull(),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
  },
  (table) => {
    return [
      index("idx_desktop_auth_handoff_codes_expires").on(table.expiresAt),
      index("idx_desktop_auth_handoff_codes_user_created").on(
        table.userId,
        table.createdAt,
      ),
    ];
  },
);
