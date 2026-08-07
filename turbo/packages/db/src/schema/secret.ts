import {
  check,
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  uniqueIndex,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { connectors } from "./connector";

/**
 * Secrets table
 * Stores encrypted third-party service secrets per user within an org
 * Values use the API stored-secret encryption envelope during KMS rollout.
 */
export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    description: text("description"),
    type: varchar("type", { length: 50 }).notNull().default("user"),
    connectorId: uuid("connector_id"),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_secrets_type").on(table.type),
      index("idx_secrets_org").on(table.orgId),
      index("idx_secrets_connector")
        .on(table.connectorId)
        .where(sql`${table.connectorId} IS NOT NULL`),
      uniqueIndex("idx_secrets_org_user_name_type")
        .on(table.orgId, table.userId, table.name, table.type)
        .where(sql`${table.connectorId} IS NULL`),
      uniqueIndex("idx_secrets_connector_name")
        .on(table.connectorId, table.name)
        .where(sql`${table.connectorId} IS NOT NULL`),
      foreignKey({
        name: "fk_secrets_connector_owner",
        columns: [table.connectorId, table.orgId, table.userId],
        foreignColumns: [connectors.id, connectors.orgId, connectors.userId],
      }).onDelete("cascade"),
      check(
        "chk_secrets_connector_owner_type",
        sql`(${table.type} = 'connector') = (${table.connectorId} IS NOT NULL)`,
      ),
    ];
  },
);
