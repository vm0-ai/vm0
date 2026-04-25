import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Secrets table
 * Stores encrypted third-party service secrets per user within an org
 * Values encrypted with AES-256-GCM using SECRETS_ENCRYPTION_KEY
 */
export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    description: text("description"),
    type: varchar("type", { length: 50 }).notNull().default("user"),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_secrets_type").on(table.type),
      index("idx_secrets_org").on(table.orgId),
      uniqueIndex("idx_secrets_org_user_name_type").on(
        table.orgId,
        table.userId,
        table.name,
        table.type,
      ),
    ];
  },
);
