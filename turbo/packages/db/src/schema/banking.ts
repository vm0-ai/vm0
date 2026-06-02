import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { zeroAgents } from "./zero-agent";

export type BankingProvider = "finicity";
export type BankingConnectionStatus =
  | "active"
  | "repair_required"
  | "revoked"
  | "deleted";
export type BankingOperationScope =
  | "accounts.read"
  | "balances.read"
  | "transactions.read";
export type BankingAuditStatus = "allowed" | "denied";

export const bankingConnections = pgTable(
  "banking_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    provider: varchar("provider", { length: 32 })
      .$type<BankingProvider>()
      .notNull()
      .default("finicity"),
    providerCustomerId: varchar("provider_customer_id", {
      length: 128,
    }).notNull(),
    status: varchar("status", { length: 32 })
      .$type<BankingConnectionStatus>()
      .notNull()
      .default("active"),
    consentExpiresAt: timestamp("consent_expires_at"),
    repairRequiredAt: timestamp("repair_required_at"),
    revokedAt: timestamp("revoked_at"),
    deletedAt: timestamp("deleted_at"),
    auditMetadata: jsonb("audit_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_banking_connections_owner_provider").on(
        table.orgId,
        table.userId,
        table.provider,
      ),
      index("idx_banking_connections_org_user").on(table.orgId, table.userId),
    ];
  },
);

export const bankingAccounts = pgTable(
  "banking_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(
        () => {
          return bankingConnections.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    providerAccountId: varchar("provider_account_id", {
      length: 128,
    }).notNull(),
    displayName: varchar("display_name", { length: 256 }),
    institutionName: varchar("institution_name", { length: 256 }),
    accountType: varchar("account_type", { length: 64 }),
    accountNumberLast4: varchar("account_number_last4", { length: 8 }),
    enabled: boolean("enabled").notNull().default(true),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_banking_accounts_connection_provider_account").on(
        table.connectionId,
        table.providerAccountId,
      ),
      index("idx_banking_accounts_org_user").on(table.orgId, table.userId),
    ];
  },
);

export const bankingAgentEnablements = pgTable(
  "banking_agent_enablements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(
        () => {
          return zeroAgents.id;
        },
        { onDelete: "cascade" },
      ),
    connectionId: uuid("connection_id")
      .notNull()
      .references(
        () => {
          return bankingConnections.id;
        },
        { onDelete: "cascade" },
      ),
    accountProviderIds: jsonb("account_provider_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    operationScopes: jsonb("operation_scopes")
      .$type<BankingOperationScope[]>()
      .notNull()
      .default(["accounts.read", "balances.read", "transactions.read"]),
    allowScheduledRuns: boolean("allow_scheduled_runs")
      .notNull()
      .default(false),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_banking_agent_enablements_unique").on(
        table.orgId,
        table.userId,
        table.agentId,
        table.connectionId,
      ),
      index("idx_banking_agent_enablements_agent_user").on(
        table.agentId,
        table.userId,
      ),
    ];
  },
);

export const bankingAccessAuditEvents = pgTable(
  "banking_access_audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runId: uuid("run_id"),
    agentId: uuid("agent_id"),
    connectionId: uuid("connection_id"),
    provider: varchar("provider", { length: 32 })
      .$type<BankingProvider>()
      .notNull()
      .default("finicity"),
    providerAccountId: varchar("provider_account_id", { length: 128 }),
    action: varchar("action", { length: 64 })
      .$type<BankingOperationScope>()
      .notNull(),
    status: varchar("status", { length: 16 })
      .$type<BankingAuditStatus>()
      .notNull(),
    failureCode: varchar("failure_code", { length: 64 }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_banking_access_audit_org_user").on(table.orgId, table.userId),
      index("idx_banking_access_audit_run").on(table.runId),
      index("idx_banking_access_audit_created").on(table.createdAt),
    ];
  },
);
