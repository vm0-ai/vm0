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

export const localAgentHosts = pgTable(
  "remote_agent_hosts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    displayName: text("display_name").notNull(),
    tokenHash: text("token_hash").notNull(),
    supportedBackends: jsonb("supported_backends")
      .$type<string[]>()
      .default([])
      .notNull(),
    status: text("status").default("online").notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_remote_agent_hosts_token_hash").on(table.tokenHash),
      index("idx_remote_agent_hosts_org_user").on(table.orgId, table.userId),
      index("idx_remote_agent_hosts_last_seen").on(table.lastSeenAt),
    ];
  },
);

export const localAgentDeviceCodes = pgTable(
  "remote_agent_device_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    codeHash: text("code_hash").notNull(),
    pollTokenHash: text("poll_token_hash").notNull(),
    orgId: text("org_id"),
    userId: text("user_id"),
    hostName: text("host_name").notNull(),
    supportedBackends: jsonb("supported_backends")
      .$type<string[]>()
      .default([])
      .notNull(),
    status: text("status").default("pending").notNull(),
    hostId: uuid("host_id").references(() => {
      return localAgentHosts.id;
    }),
    claimedAt: timestamp("claimed_at"),
    consumedAt: timestamp("consumed_at"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_remote_agent_device_codes_code_hash").on(table.codeHash),
      index("idx_remote_agent_device_codes_poll").on(
        table.codeHash,
        table.pollTokenHash,
      ),
      index("idx_remote_agent_device_codes_org_user").on(
        table.orgId,
        table.userId,
      ),
      index("idx_remote_agent_device_codes_expires").on(table.expiresAt),
    ];
  },
);

export const localAgentJobs = pgTable(
  "remote_agent_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    hostId: uuid("host_id").references(() => {
      return localAgentHosts.id;
    }),
    backend: text("backend"),
    prompt: text("prompt").notNull(),
    status: text("status").default("queued").notNull(),
    output: text("output"),
    error: text("error"),
    exitCode: integer("exit_code"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_remote_agent_jobs_host_status").on(table.hostId, table.status),
      index("idx_remote_agent_jobs_org_user").on(table.orgId, table.userId),
      index("idx_remote_agent_jobs_created").on(table.createdAt),
    ];
  },
);
