import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { zeroAgents } from "./zero-agent";

/**
 * Firewall Access Requests table
 * Stores member requests for firewall permission access with reason and status tracking.
 */
export const firewallAccessRequests = pgTable(
  "firewall_access_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(
        () => {
          return zeroAgents.id;
        },
        { onDelete: "cascade" },
      ),
    requesterUserId: text("requester_user_id").notNull(),
    firewallRef: varchar("firewall_ref", { length: 64 }).notNull(),
    permission: varchar("permission", { length: 128 }).notNull(),
    action: varchar("action", { length: 10 })
      .$type<"allow" | "deny">()
      .notNull()
      .default("allow"),
    method: varchar("method", { length: 10 }),
    path: text("path"),
    reason: text("reason"),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_firewall_access_requests_agent_status").on(
        table.agentId,
        table.status,
      ),
      index("idx_firewall_access_requests_org").on(table.orgId),
    ];
  },
);
