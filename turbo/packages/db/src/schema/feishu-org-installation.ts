import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { agentComposes } from "./agent-compose";

export const feishuOrgInstallations = pgTable(
  "feishu_org_installations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    ownerUserId: text("owner_user_id"),
    appId: varchar("app_id", { length: 255 }).notNull(),
    botName: varchar("bot_name", { length: 255 }),
    botAvatarUrl: text("bot_avatar_url"),
    encryptedAppSecret: text("encrypted_app_secret").notNull(),
    encryptedVerificationToken: text("encrypted_verification_token").notNull(),
    encryptedEncryptKey: text("encrypted_encrypt_key").notNull(),
    defaultComposeId: uuid("default_compose_id")
      .notNull()
      .references(
        () => {
          return agentComposes.id;
        },
        { onDelete: "cascade" },
      ),
    feishuTenantKey: varchar("feishu_tenant_key", { length: 255 }),
    feishuTenantName: varchar("feishu_tenant_name", { length: 255 }),
    encryptedTenantAccessToken: text("encrypted_tenant_access_token"),
    tenantAccessTokenExpiresAt: timestamp("tenant_access_token_expires_at"),
    callbackVerifiedAt: timestamp("callback_verified_at"),
    setupCompletedAt: timestamp("setup_completed_at"),
    messageReceivedAt: timestamp("message_received_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_feishu_org_installations_org").on(table.orgId),
      uniqueIndex("idx_feishu_org_installations_app").on(table.appId),
      index("idx_feishu_org_installations_tenant").on(table.feishuTenantKey),
    ];
  },
);
