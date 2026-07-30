import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const connectorOauthDeviceAuthorizationSessionStatusEnum = pgEnum(
  "connector_oauth_device_authorization_session_status",
  [
    "awaiting_user_authorization",
    "polling",
    "complete",
    "denied",
    "expired",
    "error",
  ],
);

export const connectorOauthDeviceAuthorizationSessions = pgTable(
  "connector_oauth_device_authorization_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id"),
    authorizeAgent: boolean("authorize_agent").default(false).notNull(),
    // Compatibility bridge for pre-#23793 releases. Remove in #23794.
    legacyConnectorType: varchar("connector_type", {
      length: 64,
    }).notNull(),
    connectorSlug: varchar("connector_slug", { length: 64 }).notNull(),
    authMethod: varchar("auth_method", { length: 50 }).notNull(),
    status: connectorOauthDeviceAuthorizationSessionStatusEnum("status")
      .default("awaiting_user_authorization")
      .notNull(),
    sessionTokenHash: varchar("session_token_hash", { length: 128 }).notNull(),
    encryptedProviderState: text("encrypted_provider_state").notNull(),
    userCode: varchar("user_code", { length: 255 }).notNull(),
    verificationUri: text("verification_uri").notNull(),
    verificationUriComplete: text("verification_uri_complete"),
    intervalSeconds: integer("interval_seconds").notNull(),
    errorCode: varchar("error_code", { length: 255 }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => {
    return [
      uniqueIndex("idx_connector_oauth_device_authorization_sessions_token").on(
        table.sessionTokenHash,
      ),
      index(
        "idx_connector_oauth_device_authorization_sessions_owner_status",
      ).on(
        table.orgId,
        table.userId,
        table.legacyConnectorType,
        table.authMethod,
        table.status,
      ),
      index("idx_connector_oauth_device_sessions_owner_slug_status").on(
        table.orgId,
        table.userId,
        table.connectorSlug,
        table.authMethod,
        table.status,
      ),
      index("idx_connector_oauth_device_authorization_sessions_expiration").on(
        table.status,
        table.expiresAt,
      ),
      check(
        "chk_connector_oauth_device_sessions_slug_matches_type",
        sql`${table.connectorSlug} IS NOT NULL
          AND ${table.connectorSlug} = ${table.legacyConnectorType}`,
      ),
    ];
  },
);
