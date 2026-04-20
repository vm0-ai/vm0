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
 * Phone User Links table
 * Maps verified phone numbers to VM0 users for phone channel identity linking.
 * One verification per phone number per org.
 */
export const phoneUserLinks = pgTable(
  "phone_user_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    phoneNumber: varchar("phone_number", { length: 20 }).notNull(),
    orgId: text("org_id").notNull(),
    vm0UserId: text("vm0_user_id").notNull(),
    verified: boolean("verified").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_phone_user_links_phone_org").on(
        table.phoneNumber,
        table.orgId,
      ),
      index("idx_phone_user_links_org_user").on(table.orgId, table.vm0UserId),
      index("idx_phone_user_links_org_phone").on(
        table.orgId,
        table.phoneNumber,
      ),
    ];
  },
);
