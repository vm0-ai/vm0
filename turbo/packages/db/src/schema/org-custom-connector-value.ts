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
 * Per-user value for one declared custom connector field.
 *
 * Both secret and variable values are stored with the stored-secret encryption
 * envelope. Orphan rows are intentionally preserved when admins remove fields
 * from the connector definition; runtime only considers values whose keys are
 * still declared by the active definition.
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
