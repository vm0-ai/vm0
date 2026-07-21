import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const feishuOrgInstallations = pgTable(
  "feishu_org_installations",
  {
    feishuTenantKey: varchar("feishu_tenant_key", { length: 255 })
      .notNull()
      .primaryKey(),
    feishuTenantName: varchar("feishu_tenant_name", { length: 255 }),
    feishuAppId: varchar("feishu_app_id", { length: 255 }).notNull(),
    orgId: text("org_id"),
    encryptedTenantAccessToken: text("encrypted_tenant_access_token"),
    tenantAccessTokenExpiresAt: timestamp("tenant_access_token_expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_feishu_org_installations_org").on(table.orgId),
      uniqueIndex("idx_feishu_org_installations_org_unique")
        .on(table.orgId)
        .where(sql`org_id IS NOT NULL`),
    ];
  },
);
