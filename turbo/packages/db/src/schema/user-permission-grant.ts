import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { zeroAgents } from "./zero-agent";

export type UserPermissionGrantAction = "allow" | "deny";

/**
 * Per-user zero firewall permission grants.
 *
 * This is the storage foundation for the user permission grants rollout.
 * Runtime resolution continues to use legacy agent-level columns until the
 * feature-gated service and route changes land separately.
 */
export const userPermissionGrants = pgTable(
  "user_permission_grants",
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
    // Legacy rollout bridge. Switch in #23793 and remove in #23794.
    connectorRef: varchar("connector_ref", { length: 64 }).notNull(),
    connectorSlug: varchar("connector_slug", { length: 64 }),
    permission: varchar("permission", { length: 128 }).notNull(),
    action: varchar("action", { length: 8 })
      .$type<UserPermissionGrantAction>()
      .notNull(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_user_permission_grants_grant").on(
        table.orgId,
        table.userId,
        table.agentId,
        table.connectorRef,
        table.permission,
      ),
      uniqueIndex("uq_user_permission_grants_slug_permission").on(
        table.orgId,
        table.userId,
        table.agentId,
        table.connectorSlug,
        table.permission,
      ),
      index("idx_user_permission_grants_lookup").on(
        table.orgId,
        table.userId,
        table.agentId,
      ),
      index("idx_user_permission_grants_user_id").on(table.userId),
      index("idx_user_permission_grants_agent_id").on(table.agentId),
      check(
        "chk_user_permission_grants_action",
        sql`${table.action} IN ('allow', 'deny')`,
      ),
      check(
        "chk_user_permission_grants_slug_matches_ref",
        sql`${table.connectorSlug} IS NOT NULL
          AND ${table.connectorSlug} = ${table.connectorRef}`,
      ),
    ];
  },
);
