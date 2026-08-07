import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { ModelProviderSurfaceModelMappings } from "@vm0/db/jsonb-contracts/model-provider-surface";
import { secrets } from "./secret";

export const modelProviderConnections = pgTable(
  "model_provider_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    displayName: varchar("display_name", { length: 128 }).notNull(),
    secretId: uuid("secret_id")
      .notNull()
      .references(
        () => {
          return secrets.id;
        },
        { onDelete: "cascade" },
      ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_model_provider_connections_org").on(table.orgId),
      uniqueIndex("idx_model_provider_connections_secret").on(table.secretId),
    ];
  },
);

export const modelProviderSurfaces = pgTable(
  "model_provider_surfaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(
        () => {
          return modelProviderConnections.id;
        },
        { onDelete: "cascade" },
      ),
    protocol: varchar("protocol", { length: 32 }).notNull(),
    apiBaseUrl: text("api_base_url").notNull(),
    authHeaderName: varchar("auth_header_name", { length: 128 }).notNull(),
    authHeaderTemplate: text("auth_header_template").notNull(),
    modelMappings: jsonb("model_mappings")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<ModelProviderSurfaceModelMappings>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_model_provider_surfaces_connection").on(table.connectionId),
      uniqueIndex("idx_model_provider_surfaces_connection_protocol").on(
        table.connectionId,
        table.protocol,
      ),
      check(
        "chk_model_provider_surfaces_protocol",
        sql`${table.protocol} IN ('anthropic-messages', 'openai-responses')`,
      ),
    ];
  },
);
