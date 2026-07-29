import {
  boolean,
  check,
  integer,
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  unique,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  OrgCustomConnectorFields,
  OrgCustomConnectorHeaderInjections,
  OrgCustomConnectorPrefixes,
  OrgCustomConnectorPrefixTemplates,
  OrgCustomConnectorQueryInjections,
} from "@vm0/db/jsonb-contracts/org-custom-connector";
export type {
  OrgCustomConnectorField,
  OrgCustomConnectorHeaderInjection,
  OrgCustomConnectorQueryInjection,
} from "@vm0/db/jsonb-contracts/org-custom-connector";

export type OrgCustomConnectorAuthMode = "manual" | "oauth";
export type OrgCustomConnectorMcpTransport = "streamable-http";

/**
 * Org-defined custom connectors (v1 of the connector gallery).
 *
 * This is the single organization-owned identity for both manual and OAuth
 * custom connectors. Authentication-specific state lives in the corresponding
 * value or OAuth connection tables.
 */
export const orgCustomConnectors = pgTable(
  "org_custom_connectors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
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
    mcpEndpoint: text("mcp_endpoint"),
    mcpTransport: varchar("mcp_transport", {
      length: 32,
    }).$type<OrgCustomConnectorMcpTransport>(),
    mcpResource: text("mcp_resource"),
    skillMarkdown: text("skill_markdown"),
    revision: integer("revision").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_org_custom_connectors_org").on(table.orgId),
      uniqueIndex("idx_org_custom_connectors_org_slug").on(
        table.orgId,
        table.slug,
      ),
      unique("idx_org_custom_connectors_id_org").on(table.id, table.orgId),
      check(
        "chk_org_custom_connectors_slug",
        sql`left(${table.slug}, 1) = '_'`,
      ),
      check(
        "chk_org_custom_connectors_auth_mode",
        sql`${table.authMode} IN ('manual', 'oauth')`,
      ),
      check(
        "chk_org_custom_connectors_mcp",
        sql`(
          ${table.mcpEndpoint} IS NULL
          AND ${table.mcpTransport} IS NULL
        ) OR (
          ${table.mcpEndpoint} IS NOT NULL
          AND ${table.mcpTransport} = 'streamable-http'
        )`,
      ),
      check(
        "chk_org_custom_connectors_revision_positive",
        sql`${table.revision} > 0`,
      ),
      check(
        "chk_org_custom_connectors_skill_size",
        sql`${table.skillMarkdown} IS NULL OR octet_length(${table.skillMarkdown}) <= 65536`,
      ),
    ];
  },
);
