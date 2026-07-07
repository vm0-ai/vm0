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
} from "@vm0/db/jsonb-contracts/org-custom-connector";
export type {
  OrgCustomConnectorField,
  OrgCustomConnectorHeaderInjection,
  OrgCustomConnectorQueryInjection,
} from "@vm0/db/jsonb-contracts/org-custom-connector";

/**
 * Org-defined custom connectors (v1 of the connector gallery).
 *
 * An admin registers a set of URL prefixes plus a single header template
 * (e.g. `Authorization: Bearer {{secret}}`). The runtime mitm proxy injects
 * each user's own secret at request time — the secret never enters the
 * sandbox as an env var.
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
