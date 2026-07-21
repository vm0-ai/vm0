import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { feishuOrgInstallations } from "./feishu-org-installation";

export const feishuOrgConnections = pgTable(
  "feishu_org_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    feishuOpenId: varchar("feishu_open_id", { length: 255 }).notNull(),
    feishuTenantKey: varchar("feishu_tenant_key", { length: 255 })
      .notNull()
      .references(
        () => {
          return feishuOrgInstallations.feishuTenantKey;
        },
        { onDelete: "cascade" },
      ),
    vm0UserId: text("vm0_user_id").notNull(),
    feishuUserName: varchar("feishu_user_name", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_feishu_org_connections_user_tenant").on(
        table.feishuOpenId,
        table.feishuTenantKey,
      ),
      index("idx_feishu_org_connections_vm0_tenant").on(
        table.vm0UserId,
        table.feishuTenantKey,
      ),
      index("idx_feishu_org_connections_tenant").on(table.feishuTenantKey),
    ];
  },
);
