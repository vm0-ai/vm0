import {
  pgTable,
  uuid,
  timestamp,
  text,
  varchar,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * User Secrets table
 * Stores encrypted secrets for users to use in agent compose configurations
 * Secrets are encrypted at rest using AES-256-GCM
 */
export const userSecrets = pgTable(
  "user_secrets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    encryptedValue: text("encrypted_value").notNull(), // Base64 encoded: iv:authTag:ciphertext
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    userNameIdx: uniqueIndex("idx_user_secrets_user_name").on(
      table.userId,
      table.name,
    ),
    userIdIdx: index("idx_user_secrets_user_id").on(table.userId),
  }),
);
