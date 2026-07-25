import { sql } from "drizzle-orm";
import {
  bigint,
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
import { usageEvent } from "./usage-event";

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

export const browserSessions = pgTable(
  "browser_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // External browser cleanup must survive chat-thread deletion. The terminal
    // callback or reconciler uses this durable attribution key to stop and bill
    // the provider instance after the parent thread is gone.
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
    browserProfileId: uuid("browser_profile_id")
      .notNull()
      .references(() => {
        return browserProfiles.id;
      }),
    status: varchar("status", { length: 20 })
      .$type<ZeroBrowserStatus>()
      .notNull(),
    proxyCountryCode: varchar("proxy_country_code", { length: 2 }),
    timeoutMinutes: integer("timeout_minutes").notNull(),
    maxCredits: integer("max_credits").notNull(),
    grossCredits: bigint("gross_credits", { mode: "number" })
      .default(0)
      .notNull(),
    creditsCharged: bigint("credits_charged", { mode: "number" })
      .default(0)
      .notNull(),
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
    // Provider cleanup and settlement must outlive deletion of either parent.
    chatThreadId: uuid("chat_thread_id").notNull(),
    runId: uuid("run_id").notNull(),
    // Run that owns this instance's whole cost. Chosen once when the instance
    // is claimed for stop, so retries always settle onto the same run.
    billingRunId: uuid("billing_run_id"),
    status: varchar("status", { length: 20 })
      .$type<"active" | "stopping" | "stopped">()
      .notNull(),
    browserCostMicrousd: bigint("browser_cost_microusd", { mode: "number" })
      .default(0)
      .notNull(),
    proxyCostMicrousd: bigint("proxy_cost_microusd", { mode: "number" })
      .default(0)
      .notNull(),
    proxyUsedMb: text("proxy_used_mb").default("0").notNull(),
    pricingUnitPrice: bigint("pricing_unit_price", {
      mode: "number",
    }).notNull(),
    pricingUnitSize: bigint("pricing_unit_size", { mode: "number" }).notNull(),
    grossCredits: bigint("gross_credits", { mode: "number" })
      .default(0)
      .notNull(),
    creditsCharged: bigint("credits_charged", { mode: "number" }),
    usageEventId: uuid("usage_event_id").references(
      () => {
        return usageEvent.id;
      },
      { onDelete: "set null" },
    ),
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
    settledAt: timestamp("settled_at"),
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
        table.settledAt,
        table.updatedAt,
      ),
      uniqueIndex("uq_browser_session_instances_thread_owned")
        .on(table.chatThreadId)
        .where(sql`${table.status} IN ('active', 'stopping')`),
    ];
  },
);
