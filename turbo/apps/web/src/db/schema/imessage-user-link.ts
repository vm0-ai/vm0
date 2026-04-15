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
 * iMessage User Links table
 * Maps iMessage handles (phone numbers) to VM0 users globally.
 * One iMessage handle can only be bound to a single org across the entire site.
 */
export const imessageUserLinks = pgTable(
  "imessage_user_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    imessageHandle: varchar("imessage_handle", { length: 50 }).notNull(),
    orgId: text("org_id").notNull(),
    vm0UserId: text("vm0_user_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_imessage_user_links_handle").on(table.imessageHandle),
      index("idx_imessage_user_links_org_user").on(
        table.orgId,
        table.vm0UserId,
      ),
    ];
  },
);
