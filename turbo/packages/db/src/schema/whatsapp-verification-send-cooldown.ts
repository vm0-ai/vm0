import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const whatsappVerificationSendCooldowns = pgTable(
  "whatsapp_verification_send_cooldowns",
  {
    scope: varchar("scope", { length: 32 }).notNull(),
    scopeKey: text("scope_key").notNull(),
    lastSentAt: timestamp("last_sent_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "whatsapp_verification_send_cooldowns_pkey",
        columns: [table.scope, table.scopeKey],
      }),
    ];
  },
);
