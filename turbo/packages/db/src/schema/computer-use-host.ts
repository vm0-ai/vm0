import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

type JsonObject = Record<string, unknown>;

export interface ComputerUsePermissions {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}

export const computerUseHosts = pgTable(
  "computer_use_hosts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    displayName: text("display_name").notNull(),
    tokenHash: text("token_hash").notNull(),
    appVersion: text("app_version").notNull(),
    osVersion: text("os_version").notNull(),
    supportedCapabilities: jsonb("supported_capabilities")
      .$type<string[]>()
      .default([])
      .notNull(),
    permissions: jsonb("permissions")
      .$type<ComputerUsePermissions>()
      .default({ accessibility: false, screenRecording: false })
      .notNull(),
    status: text("status").default("online").notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_computer_use_hosts_token_hash").on(table.tokenHash),
      index("idx_computer_use_hosts_org_user").on(table.orgId, table.userId),
      index("idx_computer_use_hosts_last_seen").on(table.lastSeenAt),
    ];
  },
);

export const computerUseCommands = pgTable(
  "computer_use_commands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runId: text("run_id"),
    hostId: uuid("host_id").references(() => {
      return computerUseHosts.id;
    }),
    kind: text("kind").notNull(),
    status: text("status").default("queued").notNull(),
    payload: jsonb("payload").$type<JsonObject>().default({}).notNull(),
    result: jsonb("result").$type<JsonObject>(),
    error: text("error"),
    timeoutMs: integer("timeout_ms"),
    claimedAt: timestamp("claimed_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_computer_use_commands_host_status").on(
        table.hostId,
        table.status,
      ),
      index("idx_computer_use_commands_org_user").on(table.orgId, table.userId),
      index("idx_computer_use_commands_created").on(table.createdAt),
    ];
  },
);

export const computerUseCommandAuditEvents = pgTable(
  "computer_use_command_audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    commandId: uuid("command_id")
      .references(() => {
        return computerUseCommands.id;
      })
      .notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runId: text("run_id"),
    hostId: uuid("host_id").references(() => {
      return computerUseHosts.id;
    }),
    kind: text("kind").notNull(),
    app: text("app"),
    event: text("event").notNull(),
    approvalOutcome: text("approval_outcome"),
    redactedResult: jsonb("redacted_result").$type<JsonObject>(),
    error: jsonb("error").$type<JsonObject>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_computer_use_command_audit_command").on(table.commandId),
      index("idx_computer_use_command_audit_org_user").on(
        table.orgId,
        table.userId,
      ),
      index("idx_computer_use_command_audit_created").on(table.createdAt),
    ];
  },
);
