import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";

import { orgCustomConnectors } from "./org-custom-connector";

/**
 * Legacy Custom connector secret storage retained for deployment compatibility
 * until its physical cleanup migration. Application code must use
 * connector-owned secrets instead.
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
      foreignKey({
        name: "fk_org_custom_connector_secrets_connector",
        columns: [table.connectorId, table.orgId],
        foreignColumns: [orgCustomConnectors.id, orgCustomConnectors.orgId],
      }).onDelete("cascade"),
    ];
  },
);
