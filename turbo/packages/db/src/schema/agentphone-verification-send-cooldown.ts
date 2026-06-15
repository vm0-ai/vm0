import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Cooldown state for AgentPhone verification text sends.
 *
 * Rows are keyed by a logical scope so the send route can serialize concurrent
 * requests for both the VM0 user/org and the target phone number.
 */
export const agentphoneVerificationSendCooldowns = pgTable(
  "agentphone_verification_send_cooldowns",
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
        name: "agentphone_verification_send_cooldowns_pkey",
        columns: [table.scope, table.scopeKey],
      }),
    ];
  },
);
