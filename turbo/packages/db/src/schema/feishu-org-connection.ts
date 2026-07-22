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
    installationId: uuid("installation_id")
      .notNull()
      .references(
        () => {
          return feishuOrgInstallations.id;
        },
        { onDelete: "cascade" },
      ),
    feishuOpenId: varchar("feishu_open_id", { length: 255 }).notNull(),
    vm0UserId: text("vm0_user_id").notNull(),
    feishuUserName: varchar("feishu_user_name", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_feishu_org_connections_user_installation").on(
        table.feishuOpenId,
        table.installationId,
      ),
      index("idx_feishu_org_connections_vm0_installation").on(
        table.vm0UserId,
        table.installationId,
      ),
      index("idx_feishu_org_connections_installation").on(table.installationId),
    ];
  },
);
