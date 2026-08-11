import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { storages } from "./storage";

export type CustomConnectorSkillPublicationState =
  | "preparing"
  | "cleanup_claimed";

export const customConnectorSkillPublications = pgTable(
  "custom_connector_skill_publications",
  {
    versionId: varchar("version_id", { length: 64 }).primaryKey(),
    storageId: uuid("storage_id")
      .notNull()
      .references(
        () => {
          return storages.id;
        },
        { onDelete: "cascade" },
      ),
    s3Prefix: text("s3_prefix").notNull(),
    state: varchar("state", { length: 32 })
      .$type<CustomConnectorSkillPublicationState>()
      .notNull(),
    stateUpdatedAt: timestamp("state_updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      check(
        "chk_custom_connector_skill_publications_state",
        sql`${table.state} IN ('preparing', 'cleanup_claimed')`,
      ),
      index("idx_custom_connector_skill_publications_state_time").on(
        table.state,
        table.stateUpdatedAt,
        table.versionId,
      ),
    ];
  },
);

export const deletedCustomConnectorSkillStorages = pgTable(
  "deleted_custom_connector_skill_storages",
  {
    storageId: uuid("storage_id").primaryKey(),
    connectorId: uuid("connector_id").notNull(),
    s3Prefix: text("s3_prefix").notNull(),
    deletedAt: timestamp("deleted_at").notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_deleted_custom_connector_skill_storages_connector").on(
        table.connectorId,
      ),
      index("idx_deleted_custom_connector_skill_storages_deleted").on(
        table.deletedAt,
        table.storageId,
      ),
    ];
  },
);
