import {
  boolean,
  check,
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
import { modelProviders } from "./model-provider";

/**
 * Organization-level model-first policy.
 *
 * Stores admin-controlled model availability, recommendation order, and the
 * default route for each canonical model. Credentials stay in
 * `model_providers`/`secrets`; this table only decides which model routes the
 * workspace exposes once the model-first feature switch is enabled.
 */
export const orgModelPolicies = pgTable(
  "org_model_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    model: varchar("model", { length: 255 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull(),
    defaultProviderType: varchar("default_provider_type", {
      length: 50,
    })
      .notNull()
      .default("vm0"),
    credentialScope: varchar("credential_scope", { length: 20 })
      .notNull()
      .default("org"),
    modelProviderId: uuid("model_provider_id").references(
      () => {
        return modelProviders.id;
      },
      { onDelete: "set null" },
    ),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_org_model_policies_org_model").on(
        table.orgId,
        table.model,
      ),
      uniqueIndex("idx_org_model_policies_org_sort_order").on(
        table.orgId,
        table.sortOrder,
      ),
      index("idx_org_model_policies_enabled_sort").on(
        table.orgId,
        table.enabled,
        table.sortOrder,
      ),
      index("idx_org_model_policies_provider")
        .on(table.modelProviderId)
        .where(sql`model_provider_id IS NOT NULL`),
      check(
        "chk_org_model_policies_credential_scope",
        sql`credential_scope IN ('org', 'member')`,
      ),
      check(
        "chk_org_model_policies_member_scope_no_provider_id",
        sql`credential_scope <> 'member' OR model_provider_id IS NULL`,
      ),
      check(
        "chk_org_model_policies_org_scope_provider_id",
        sql`credential_scope <> 'org' OR default_provider_type = 'vm0' OR model_provider_id IS NOT NULL`,
      ),
      check(
        "chk_org_model_policies_member_scope_oauth_provider",
        sql`credential_scope <> 'member' OR default_provider_type IN ('claude-code-oauth-token', 'codex-oauth-token')`,
      ),
      check(
        "chk_org_model_policies_oauth_provider_member_scope",
        sql`default_provider_type NOT IN ('claude-code-oauth-token', 'codex-oauth-token') OR credential_scope = 'member'`,
      ),
    ];
  },
);
