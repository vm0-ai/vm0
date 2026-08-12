import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  uniqueIndex,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import { orgCustomConnectors } from "./org-custom-connector";

/**
 * Legacy Custom connector credential storage retained for deployment
 * compatibility until its physical cleanup migration. Application code must
 * use connector-owned secrets and variables instead.
 */
export const orgCustomConnectorValues = pgTable(
  "org_custom_connector_values",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectorId: uuid("connector_id").notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    kind: varchar("kind", { length: 16 }).notNull(),
    key: varchar("key", { length: 64 }).notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_org_custom_connector_values_connector").on(table.connectorId),
      index("idx_org_custom_connector_values_user").on(table.userId),
      uniqueIndex("idx_org_custom_connector_values_unique").on(
        table.connectorId,
        table.userId,
        table.kind,
        table.key,
      ),
      foreignKey({
        name: "fk_org_custom_connector_values_connector",
        columns: [table.connectorId, table.orgId],
        foreignColumns: [orgCustomConnectors.id, orgCustomConnectors.orgId],
      }).onDelete("cascade"),
    ];
  },
);
