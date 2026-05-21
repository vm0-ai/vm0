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
 * Official shared WhatsApp user links.
 *
 * One WhatsApp sender number can connect to exactly one VM0 account/org at a
 * time for the shared Twilio WhatsApp transport.
 */
export const whatsappUserLinks = pgTable(
  "whatsapp_user_links",
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
      uniqueIndex("idx_whatsapp_user_links_phone_handle").on(table.phoneHandle),
      uniqueIndex("idx_whatsapp_user_links_vm0_org").on(
        table.vm0UserId,
        table.orgId,
      ),
      index("idx_whatsapp_user_links_org").on(table.orgId),
    ];
  },
);
