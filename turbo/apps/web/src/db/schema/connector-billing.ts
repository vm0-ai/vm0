import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

/**
 * Per-API-call connector billing records.
 *
 * Each billable connector API call observed by mitmproxy creates one row,
 * keyed by (runId, flowId, category) for deduplication.  Processed later
 * by a billing processor to charge credits.
 *
 * Only billable connectors (firewalls listed in `BILLABLE_CONNECTORS` in
 * `@vm0/core`, surfaced to the addon as `flow.metadata["firewall_billable"]`
 * via `billableFirewalls` on the execution context) and successful (2xx)
 * responses produce records.
 */
export const connectorBilling = pgTable(
  "connector_billing",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "set null" },
    ),
    flowId: varchar("flow_id", { length: 100 }).notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    connector: varchar("connector", { length: 50 }).notNull(),
    category: varchar("category", { length: 100 }).notNull(),
    quantity: integer("quantity").notNull().default(0),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
  },
  (table) => {
    return [
      uniqueIndex("uq_connector_billing_run_flow_category").on(
        table.runId,
        table.flowId,
        table.category,
      ),
      index("idx_connector_billing_run_id").on(table.runId),
      index("idx_connector_billing_org_status").on(table.orgId, table.status),
      index("idx_connector_billing_org_created").on(
        table.orgId,
        table.createdAt.desc(),
      ),
      index("idx_connector_billing_org_user_status_processed").on(
        table.orgId,
        table.userId,
        table.status,
        table.processedAt,
      ),
    ];
  },
);
