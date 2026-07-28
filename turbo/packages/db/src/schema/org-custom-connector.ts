import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
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
  OrgCustomConnectorAuthMethods,
} from "@vm0/db/jsonb-contracts/org-custom-connector";
export type {
  OrgCustomConnectorAuthMethod,
  OrgCustomConnectorApiAuthMethod,
  OrgCustomConnectorField,
  OrgCustomConnectorHeaderInjection,
  OrgCustomConnectorOAuth2AuthMethod,
  OrgCustomConnectorQueryInjection,
} from "@vm0/db/jsonb-contracts/org-custom-connector";

/**
 * Org-defined custom connectors (v1 of the connector gallery).
 *
 * An admin registers URL prefixes, authentication methods, and any shared OAuth
 * app credentials. The runtime mitm proxy injects each user's API credential or
 * OAuth token at request time, so credential values never enter the sandbox.
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
    authMethods: jsonb("auth_methods")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<OrgCustomConnectorAuthMethods>(),
    encryptedOauthClientId: text("encrypted_oauth_client_id"),
    encryptedOauthClientSecret: text("encrypted_oauth_client_secret"),
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
    ];
  },
);
