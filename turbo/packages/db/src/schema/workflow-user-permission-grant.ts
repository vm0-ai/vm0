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
import { zeroWorkflows } from "./zero-workflow";

export type WorkflowUserPermissionGrantAction = "allow" | "deny";

/**
 * Per-user workflow firewall permission grants.
 *
 * These grants are shared by all triggers the user owns for the workflow.
 */
export const workflowUserPermissionGrants = pgTable(
  "workflow_user_permission_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(
        () => {
          return zeroWorkflows.id;
        },
        { onDelete: "cascade" },
      ),
    connectorRef: varchar("connector_ref", { length: 64 }).notNull(),
    permission: varchar("permission", { length: 128 }).notNull(),
    action: varchar("action", { length: 8 })
      .$type<WorkflowUserPermissionGrantAction>()
      .notNull(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_workflow_user_permission_grants_grant").on(
        table.orgId,
        table.userId,
        table.workflowId,
        table.connectorRef,
        table.permission,
      ),
      index("idx_workflow_user_permission_grants_lookup").on(
        table.orgId,
        table.userId,
        table.workflowId,
      ),
      index("idx_workflow_user_permission_grants_user_id").on(table.userId),
      index("idx_workflow_user_permission_grants_workflow_id").on(
        table.workflowId,
      ),
      check(
        "chk_workflow_user_permission_grants_action",
        sql`${table.action} IN ('allow', 'deny')`,
      ),
    ];
  },
);
