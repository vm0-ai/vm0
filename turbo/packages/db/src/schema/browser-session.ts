import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  ZeroBrowserStatus,
  ZeroBrowserSuspensionReason,
} from "@vm0/api-contracts/contracts/zero-browser";

import { agentRuns } from "./agent-run";

export const browserProfiles = pgTable(
  "browser_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    providerProfileId: uuid("provider_profile_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_browser_profiles_owner").on(table.orgId, table.userId),
      uniqueIndex("uq_browser_profiles_provider_profile").on(
        table.providerProfileId,
      ),
    ];
  },
);

/**
 * Thread-scoped profiles used by all new managed browsers.
 *
 * browserProfiles remains the compatibility store while API versions that
 * predate thread scope can still serve traffic. New sessions dual-reference a
 * legacy owner profile and this thread profile; current APIs always prefer the
 * thread profile. The legacy reference can be removed only after the previous
 * API version has fully drained.
 */
export const browserThreadProfiles = pgTable(
  "browser_thread_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chatThreadId: uuid("chat_thread_id").notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    providerProfileId: uuid("provider_profile_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_browser_thread_profiles_thread").on(table.chatThreadId),
      uniqueIndex("uq_browser_thread_profiles_provider_profile").on(
        table.providerProfileId,
      ),
      index("idx_browser_thread_profiles_owner").on(table.orgId, table.userId),
    ];
  },
);

export const browserSessions = pgTable(
  "browser_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // External browser cleanup must survive chat-thread deletion. The delete
    // path and reconciler use this durable key after the parent thread is gone.
    chatThreadId: uuid("chat_thread_id").notNull(),
    runId: uuid("run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "set null" },
    ),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    /**
     * Compatibility reference required by API versions that predate thread
     * profiles. New sessions dual-write this and browserThreadProfileId.
     */
    browserProfileId: uuid("browser_profile_id")
      .notNull()
      .references(() => {
        return browserProfiles.id;
      }),
    /** Thread-scoped profile preferred by current APIs when present. */
    browserThreadProfileId: uuid("browser_thread_profile_id").references(() => {
      return browserThreadProfiles.id;
    }),
    status: varchar("status", { length: 20 })
      .$type<ZeroBrowserStatus>()
      .notNull(),
    proxyCountryCode: varchar("proxy_country_code", { length: 2 }),
    timeoutMinutes: integer("timeout_minutes").notNull(),
    suspendedAt: timestamp("suspended_at"),
    suspensionReason: varchar("suspension_reason", {
      length: 20,
    }).$type<ZeroBrowserSuspensionReason>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_browser_sessions_chat_thread_created").on(
        table.chatThreadId,
        table.createdAt.desc(),
      ),
      index("idx_browser_sessions_owner_created").on(
        table.orgId,
        table.userId,
        table.createdAt.desc(),
      ),
      index("idx_browser_sessions_reconcile").on(table.status, table.updatedAt),
      uniqueIndex("uq_browser_sessions_thread_owned")
        .on(table.chatThreadId)
        .where(
          sql`${table.status} IN ('creating', 'active', 'resuming', 'stopping')`,
        ),
    ];
  },
);

export const browserAuthorizationRequests = pgTable(
  "browser_authorization_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestTokenHash: text("request_token_hash").notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runId: uuid("run_id").notNull(),
    chatThreadId: uuid("chat_thread_id").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_browser_authorization_requests_token_hash").on(
        table.requestTokenHash,
      ),
      index("idx_browser_authorization_requests_owner").on(
        table.orgId,
        table.userId,
      ),
      index("idx_browser_authorization_requests_expires").on(table.expiresAt),
    ];
  },
);

export const browserSessionInstances = pgTable(
  "browser_session_instances",
  {
    providerSessionId: uuid("provider_session_id").primaryKey(),
    browserSessionId: uuid("browser_session_id")
      .notNull()
      .references(
        () => {
          return browserSessions.id;
        },
        { onDelete: "cascade" },
      ),
    // These IDs are immutable attribution keys rather than ownership FKs.
    // Provider cleanup must outlive deletion of either parent.
    chatThreadId: uuid("chat_thread_id").notNull(),
    runId: uuid("run_id").notNull(),
    status: varchar("status", { length: 20 })
      .$type<"active" | "stopping" | "stopped">()
      .notNull(),
    timeoutAt: timestamp("timeout_at").notNull(),
    startedAt: timestamp("started_at").notNull(),
    // Idle lease. Any run or open viewer touches the instance, and the
    // reconciler reclaims it once the lease expires. updatedAt cannot carry
    // this because the reconciler bumps updatedAt on every healthy pass.
    lastTouchedAt: timestamp("last_touched_at").defaultNow().notNull(),
    // The default grants a full lease window so rows inserted by an API version
    // that predates this column are not reclaimed the moment they are created.
    idleExpiresAt: timestamp("idle_expires_at")
      .default(sql`now() + interval '10 minutes'`)
      .notNull(),
    stopRequestedAt: timestamp("stop_requested_at"),
    finishedAt: timestamp("finished_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_browser_session_instances_session").on(
        table.browserSessionId,
        table.createdAt.desc(),
      ),
      index("idx_browser_session_instances_run_status").on(
        table.runId,
        table.status,
      ),
      index("idx_browser_session_instances_reconcile").on(
        table.status,
        table.updatedAt,
      ),
      uniqueIndex("uq_browser_session_instances_thread_owned")
        .on(table.chatThreadId)
        .where(sql`${table.status} IN ('active', 'stopping')`),
    ];
  },
);

/**
 * Resize capability and persisted dimensions for provider instances created
 * by APIs that support manual window fitting.
 *
 * Keeping this state in a companion table preserves the statement shape of
 * browser_session_instances while the previous API and migration 0737 may
 * deploy in either order. Row absence means the instance is not resizable.
 */
export const browserSessionResizeStates = pgTable(
  "browser_session_resize_states",
  {
    providerSessionId: uuid("provider_session_id")
      .primaryKey()
      .references(
        () => {
          return browserSessionInstances.providerSessionId;
        },
        { onDelete: "cascade" },
      ),
    screenWidth: integer("screen_width").notNull(),
    screenHeight: integer("screen_height").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
);
