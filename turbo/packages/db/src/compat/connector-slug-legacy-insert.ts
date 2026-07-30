import {
  bigint,
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { connectorExternalCodeSessionStatusEnum } from "../schema/connector-external-code-session";
import { connectorOauthDeviceAuthorizationSessionStatusEnum } from "../schema/connector-oauth-device-authorization-session";
import type { UserPermissionGrantAction } from "../schema/user-permission-grant";

/**
 * Previous-release insert projections for connector_slug rollout tests.
 *
 * They intentionally omit connector_slug to model the expand release running
 * before and after the cutover migration. Current application writes use the
 * canonical projections; delete these legacy projections in #23794.
 */
export const connectorSlugLegacyInsertConnectors = pgTable("connectors", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: varchar("type", { length: 64 }),
  customConnectorId: uuid("custom_connector_id"),
  authMethod: varchar("auth_method", { length: 50 }).notNull(),
  storageVersion: bigint("storage_version", { mode: "number" }).notNull(),
  externalId: varchar("external_id", { length: 255 }),
  externalUsername: varchar("external_username", { length: 255 }),
  externalEmail: varchar("external_email", { length: 255 }),
  oauthScopes: text("oauth_scopes"),
  tokenExpiresAt: timestamp("token_expires_at"),
  userId: text("user_id").notNull(),
  orgId: text("org_id").notNull(),
  needsReconnect: boolean("needs_reconnect").notNull().default(false),
  reconnectReason: varchar("reconnect_reason", { length: 64 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const connectorSlugLegacyInsertUserConnectors = pgTable(
  "user_connectors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    connectorType: varchar("connector_type", { length: 64 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
);

export const connectorSlugLegacyInsertOauthStates = pgTable(
  "connector_oauth_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    state: text("state").notNull(),
    type: varchar("type", { length: 64 }),
    customConnectorId: uuid("custom_connector_id"),
    connectorRevision: integer("connector_revision"),
    authMethod: varchar("auth_method", { length: 50 }).notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id"),
    authorizeAgent: boolean("authorize_agent").default(false).notNull(),
    redirectUri: text("redirect_uri").notNull(),
    authorizationUrl: text("authorization_url"),
    codeVerifier: text("code_verifier"),
    oauthContext: text("oauth_context"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
  },
);

export const connectorSlugLegacyInsertOauthDeviceSessions = pgTable(
  "connector_oauth_device_authorization_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id"),
    authorizeAgent: boolean("authorize_agent").default(false).notNull(),
    connectorType: varchar("connector_type", { length: 64 }).notNull(),
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
);

export const connectorSlugLegacyInsertExternalCodeSessions = pgTable(
  "connector_external_code_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id"),
    authorizeAgent: boolean("authorize_agent").default(false).notNull(),
    connectorType: varchar("connector_type", { length: 64 }).notNull(),
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
);

export const connectorSlugLegacyInsertUserPermissionGrants = pgTable(
  "user_permission_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    connectorRef: varchar("connector_ref", { length: 64 }).notNull(),
    permission: varchar("permission", { length: 128 }).notNull(),
    action: varchar("action", { length: 8 })
      .$type<UserPermissionGrantAction>()
      .notNull(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
);
