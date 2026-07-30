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
 * Temporary insert-only projections for the connector_slug cutover.
 *
 * They omit the physically required legacy identity columns so current
 * application writes are canonical-only. Migration 0738 triggers mirror
 * connector_slug into those legacy columns for rollback compatibility. Remove
 * these projections with the legacy columns in #23794.
 */
export const connectorSlugCanonicalInsertConnectors = pgTable("connectors", {
  id: uuid("id").defaultRandom().primaryKey(),
  connectorSlug: varchar("connector_slug", { length: 64 }),
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

export const connectorSlugCanonicalInsertUserConnectors = pgTable(
  "user_connectors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    connectorSlug: varchar("connector_slug", { length: 64 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
);

export const connectorSlugCanonicalInsertOauthStates = pgTable(
  "connector_oauth_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    state: text("state").notNull(),
    connectorSlug: varchar("connector_slug", { length: 64 }),
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

export const connectorSlugCanonicalInsertOauthDeviceSessions = pgTable(
  "connector_oauth_device_authorization_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id"),
    authorizeAgent: boolean("authorize_agent").default(false).notNull(),
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
);

export const connectorSlugCanonicalInsertExternalCodeSessions = pgTable(
  "connector_external_code_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id"),
    authorizeAgent: boolean("authorize_agent").default(false).notNull(),
    connectorSlug: varchar("connector_slug", { length: 64 }).notNull(),
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

export const connectorSlugCanonicalInsertUserPermissionGrants = pgTable(
  "user_permission_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    connectorSlug: varchar("connector_slug", { length: 64 }).notNull(),
    permission: varchar("permission", { length: 128 }).notNull(),
    action: varchar("action", { length: 8 })
      .$type<UserPermissionGrantAction>()
      .notNull(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
);
