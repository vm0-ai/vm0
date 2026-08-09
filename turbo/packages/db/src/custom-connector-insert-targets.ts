import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import type {
  OrgCustomConnectorFields,
  OrgCustomConnectorHeaderInjections,
  OrgCustomConnectorPrefixes,
  OrgCustomConnectorPrefixTemplates,
  OrgCustomConnectorQueryInjections,
} from "./jsonb-contracts/org-custom-connector";
import type { OrgCustomConnectorAuthMode } from "./schema/org-custom-connector";

/**
 * Temporary insert targets for the #25352 schema contraction.
 *
 * Drizzle inserts every column declared by their target, including omitted
 * columns as DEFAULT. Remove these projections and restore canonical insert
 * targets in #25352 after this API release is promoted and drained.
 */
export const orgCustomConnectorsInsertTarget = pgTable(
  "org_custom_connectors",
  {
    orgId: text("org_id").notNull(),
    slug: varchar("slug", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 128 }).notNull(),
    prefixes: jsonb("prefixes").notNull().$type<OrgCustomConnectorPrefixes>(),
    headerName: varchar("header_name", { length: 128 }).notNull(),
    headerTemplate: text("header_template").notNull(),
    prefixTemplates: jsonb("prefix_templates")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<OrgCustomConnectorPrefixTemplates>(),
    fields: jsonb("fields")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<OrgCustomConnectorFields>(),
    headerInjections: jsonb("header_injections")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<OrgCustomConnectorHeaderInjections>(),
    queryInjections: jsonb("query_injections")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<OrgCustomConnectorQueryInjections>(),
    authMode: varchar("auth_mode", { length: 16 })
      .$type<OrgCustomConnectorAuthMode>()
      .notNull()
      .default("manual"),
    enabled: boolean("enabled").notNull().default(true),
    permissionBundleRef: varchar("permission_bundle_ref", { length: 128 }),
    skillMarkdown: text("skill_markdown"),
    storageVersion: bigint("storage_version", { mode: "number" })
      .notNull()
      .default(1),
    createdBy: text("created_by").notNull(),
  },
);

export const userCustomConnectorsInsertTarget = pgTable(
  "user_custom_connectors",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    customConnectorId: uuid("custom_connector_id").notNull(),
    permissionNames: text("permission_names")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
);

export const connectorOauthStatesInsertTarget = pgTable(
  "connector_oauth_states",
  {
    state: text("state").notNull(),
    connectorSlug: varchar("connector_slug", { length: 64 }),
    customConnectorId: uuid("custom_connector_id"),
    storageVersion: bigint("storage_version", { mode: "number" }),
    authMethod: varchar("auth_method", { length: 50 }).notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id"),
    authorizeAgent: boolean("authorize_agent").default(false).notNull(),
    redirectUri: text("redirect_uri").notNull(),
    authorizationUrl: text("authorization_url"),
    codeVerifier: text("code_verifier"),
    oauthContext: text("oauth_context"),
    expiresAt: timestamp("expires_at").notNull(),
  },
);
