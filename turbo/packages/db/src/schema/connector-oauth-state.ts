import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { orgCustomConnectors } from "./org-custom-connector";

export const connectorOauthStates = pgTable(
  "connector_oauth_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    state: text("state").notNull(),
    connectorSlug: varchar("connector_slug", { length: 64 }),
    customConnectorId: uuid("custom_connector_id"),
    connectorRevision: integer("connector_revision"),
    authMethod: varchar("auth_method", { length: 50 }).notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id"),
    authorizeAgent: boolean("authorize_agent").default(false).notNull(),
    redirectUri: text("redirect_uri").notNull(),
    authorizationUrl: text("authorization_url"),
    codeVerifier: text("code_verifier"),
    oauthContext: text("oauth_context"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
  },
  (table) => {
    return [
      uniqueIndex("idx_connector_oauth_states_state").on(table.state),
      index("idx_connector_oauth_states_user_org").on(
        table.userId,
        table.orgId,
      ),
      index("idx_connector_oauth_states_expires_at").on(table.expiresAt),
      foreignKey({
        name: "fk_connector_oauth_states_custom_connector",
        columns: [table.customConnectorId, table.orgId],
        foreignColumns: [orgCustomConnectors.id, orgCustomConnectors.orgId],
      }).onDelete("cascade"),
      check(
        "chk_connector_oauth_states_identity",
        sql`num_nonnulls(${table.connectorSlug}, ${table.customConnectorId}) = 1`,
      ),
      check(
        "chk_connector_oauth_states_custom_revision",
        sql`(
          ${table.customConnectorId} IS NULL
          AND ${table.connectorRevision} IS NULL
        ) OR (
          ${table.customConnectorId} IS NOT NULL
          AND ${table.connectorRevision} IS NOT NULL
        )`,
      ),
    ];
  },
);
