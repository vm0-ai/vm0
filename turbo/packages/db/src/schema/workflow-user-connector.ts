import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { zeroWorkflows } from "./zero-workflow";

/**
 * Workflow-scoped connector access.
 *
 * Stores which connected services a user has enabled for a specific workflow.
 * Trigger-fired runs execute as the trigger owner and resolve connector access
 * from this table instead of from individual trigger rows.
 */
export const workflowUserConnectors = pgTable(
  "workflow_user_connectors",
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
    connectorType: varchar("connector_type", { length: 50 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_workflow_user_connectors_unique").on(
        table.orgId,
        table.userId,
        table.workflowId,
        table.connectorType,
      ),
      index("idx_workflow_user_connectors_workflow_user").on(
        table.workflowId,
        table.userId,
      ),
    ];
  },
);
