import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const connectorExternalCodeSessionStatusEnum = pgEnum(
  "connector_external_code_session_status",
  ["pending", "completing", "complete", "expired", "error"],
);

export const connectorExternalCodeSessions = pgTable(
  "connector_external_code_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    connectorType: varchar("connector_type", { length: 50 }).notNull(),
    authMethod: varchar("auth_method", { length: 50 }).notNull(),
    status: connectorExternalCodeSessionStatusEnum("status")
      .default("pending")
      .notNull(),
    sessionTokenHash: varchar("session_token_hash", { length: 128 }).notNull(),
    encryptedProviderState: text("encrypted_provider_state").notNull(),
    authorizationUrl: text("authorization_url").notNull(),
    errorCode: varchar("error_code", { length: 255 }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => {
    return [
      uniqueIndex("idx_connector_external_code_sessions_token").on(
        table.sessionTokenHash,
      ),
      index("idx_connector_external_code_sessions_owner_status").on(
        table.orgId,
        table.userId,
        table.connectorType,
        table.authMethod,
        table.status,
      ),
      index("idx_connector_external_code_sessions_expiration").on(
        table.status,
        table.expiresAt,
      ),
    ];
  },
);
