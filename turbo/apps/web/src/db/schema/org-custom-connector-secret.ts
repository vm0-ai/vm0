import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Per-user secret for an org custom connector.
 *
 * Encrypted with AES-256-GCM using SECRETS_ENCRYPTION_KEY. The row is keyed
 * by `(connectorId, userId)`: each user supplies their own secret; a missing
 * row means the user hasn't configured the connector yet.
 */
export const orgCustomConnectorSecrets = pgTable(
  "org_custom_connector_secrets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectorId: uuid("connector_id").notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_org_custom_connector_secrets_connector").on(table.connectorId),
      index("idx_org_custom_connector_secrets_user").on(table.userId),
      uniqueIndex("idx_org_custom_connector_secrets_connector_user").on(
        table.connectorId,
        table.userId,
      ),
    ];
  },
);
