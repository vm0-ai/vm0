import {
  pgTable,
  uuid,
  varchar,
  text,
  bigint,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentRuns } from "./agent-run";

/**
 * Per-event usage record for billable resources.
 *
 * One row per billable event (connector API call, model token usage, image
 * generation, future external-API call, etc.). Resource is identified by a
 * three-level classification — `kind` / `provider` / `category` — so queries
 * can filter at any level without string-parsing.
 *
 *   kind      provider                     category
 *   --------  ---------------------------  ------------------
 *   connector x                            tweet.read
 *   connector github                       issue.write
 *   model     claude-sonnet-4-6            tokens.input
 *   model     claude-sonnet-4-6            tokens.output
 *   image     gemini-2.5-flash-image       output_tokens
 *   image     gemini-2.5-flash-image       input_tokens
 *   image     gpt-image-2                  tokens.output.image
 *
 * Charging is applied by the billing processor, which looks up the
 * `(kind, provider, category)` triple in a pricing table and writes
 * `creditsCharged`.
 *
 * `billingError` is a short code naming a billing-time problem on the
 * row. NULL on healthy rows. Ops queries `WHERE billing_error IS NOT
 * NULL` to find revenue leaks and classification gaps. Known codes:
 *   - `missing_pricing`  — no row in `usage_pricing` matched either
 *     the exact `(kind, provider, category)` triple or the provider's
 *     `__fallback__` row; billed as `creditsCharged = 0` (revenue leak).
 *   - `fallback_pricing` — the exact `(kind, provider, category)` was
 *     unseeded, but the provider's `(kind, provider, "__fallback__")`
 *     row matched; billed at that fallback rate (classification gap).
 *
 * `idempotencyKey` is a caller-provided UUID for exactly-once semantics.
 * Writers must keep the same UUID across retries of the same logical
 * event; the UNIQUE index blocks duplicate insertions.
 */
export const usageEvent = pgTable(
  "usage_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "set null" },
    ),
    idempotencyKey: uuid("idempotency_key").notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    kind: varchar("kind", { length: 30 }).notNull(),
    provider: varchar("provider", { length: 100 }).notNull(),
    category: varchar("category", { length: 100 }).notNull(),
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    creditsCharged: bigint("credits_charged", { mode: "number" }),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    billingError: varchar("billing_error", { length: 50 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
  },
  (table) => {
    return [
      uniqueIndex("uq_usage_event_idempotency_key").on(table.idempotencyKey),
      index("idx_usage_event_run_id").on(table.runId),
      index("idx_usage_event_org_status").on(table.orgId, table.status),
      index("idx_usage_event_org_created").on(
        table.orgId,
        table.createdAt.desc(),
      ),
      index("idx_usage_event_model_created")
        .on(table.createdAt.desc())
        .where(sql`${table.kind} = 'model'`),
      index("idx_usage_event_org_user_status_processed").on(
        table.orgId,
        table.userId,
        table.status,
        table.processedAt,
      ),
      // Supports aggregate-insights recent processed-ledger discovery and
      // per-window credit aggregation.
      index("idx_usage_event_processed_org_user")
        .on(table.processedAt.desc(), table.orgId, table.userId)
        .where(
          sql`${table.status} = 'processed' AND ${table.processedAt} IS NOT NULL`,
        ),
    ];
  },
);
