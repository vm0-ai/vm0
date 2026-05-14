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

export const localBrowserHosts = pgTable(
  "local_browser_hosts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    displayName: text("display_name").notNull(),
    tokenHash: text("token_hash").notNull(),
    browser: text("browser").notNull(),
    extensionVersion: text("extension_version").notNull(),
    supportedCapabilities: jsonb("supported_capabilities")
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
      uniqueIndex("idx_local_browser_hosts_token_hash").on(table.tokenHash),
      index("idx_local_browser_hosts_org_user").on(table.orgId, table.userId),
      index("idx_local_browser_hosts_last_seen").on(table.lastSeenAt),
    ];
  },
);

export const localBrowserDeviceCodes = pgTable(
  "local_browser_device_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    codeHash: text("code_hash").notNull(),
    pollTokenHash: text("poll_token_hash").notNull(),
    orgId: text("org_id"),
    userId: text("user_id"),
    hostName: text("host_name").notNull(),
    browser: text("browser").notNull(),
    extensionVersion: text("extension_version").notNull(),
    supportedCapabilities: jsonb("supported_capabilities")
      .$type<string[]>()
      .default([])
      .notNull(),
    status: text("status").default("pending").notNull(),
    hostId: uuid("host_id").references(() => {
      return localBrowserHosts.id;
    }),
    claimedAt: timestamp("claimed_at"),
    consumedAt: timestamp("consumed_at"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_local_browser_device_codes_code_hash").on(
        table.codeHash,
      ),
      index("idx_local_browser_device_codes_poll").on(
        table.codeHash,
        table.pollTokenHash,
      ),
      index("idx_local_browser_device_codes_org_user").on(
        table.orgId,
        table.userId,
      ),
      index("idx_local_browser_device_codes_expires").on(table.expiresAt),
    ];
  },
);

export const localBrowserCommands = pgTable(
  "local_browser_commands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runId: text("run_id"),
    hostId: uuid("host_id").references(() => {
      return localBrowserHosts.id;
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
      index("idx_local_browser_commands_host_status").on(
        table.hostId,
        table.status,
      ),
      index("idx_local_browser_commands_org_user").on(
        table.orgId,
        table.userId,
      ),
      index("idx_local_browser_commands_created").on(table.createdAt),
    ];
  },
);
