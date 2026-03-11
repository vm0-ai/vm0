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
 * Stores encrypted third-party service secrets per user within a scope
 * Values encrypted with AES-256-GCM using SECRETS_ENCRYPTION_KEY
 */
export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scopeId: uuid("scope_id"),
    name: varchar("name", { length: 255 }).notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    description: text("description"),
    type: varchar("type", { length: 50 }).notNull().default("user"),
    userId: text("user_id").notNull(),
    clerkOrgId: text("clerk_org_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_secrets_type").on(table.type),
    index("idx_secrets_clerk_org").on(table.clerkOrgId),
    uniqueIndex("idx_secrets_clerk_org_user_name_type").on(
      table.clerkOrgId,
      table.userId,
      table.name,
      table.type,
    ),
  ],
);
