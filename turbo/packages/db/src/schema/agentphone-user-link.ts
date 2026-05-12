import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Official shared AgentPhone user links.
 *
 * The shared AgentPhone number is global: one external phone handle can
 * connect to exactly one active VM0 account/org at a time.
 */
export const agentphoneUserLinks = pgTable(
  "agentphone_user_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    phoneHandle: varchar("phone_handle", { length: 32 }).notNull(),
    vm0UserId: text("vm0_user_id").notNull(),
    orgId: text("org_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_agentphone_user_links_phone_handle").on(
        table.phoneHandle,
      ),
      uniqueIndex("idx_agentphone_user_links_vm0_org").on(
        table.vm0UserId,
        table.orgId,
      ),
      index("idx_agentphone_user_links_org").on(table.orgId),
    ];
  },
);
