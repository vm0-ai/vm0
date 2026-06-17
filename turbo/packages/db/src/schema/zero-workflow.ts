import {
  pgTable,
  uuid,
  timestamp,
  text,
  varchar,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { zeroAgents } from "./zero-agent";

/**
 * Zero workflow visibility.
 *
 * Public workflows are visible within the org. Private workflows are visible
 * only to their owner. The backing package is still a skill directory and is
 * stored through the existing custom-skill volume storage name.
 */
export type ZeroWorkflowVisibility = "public" | "private";

/**
 * Zero Workflows table
 * Org-scoped registry of workflows. Each row represents workflow metadata.
 * Workflow content is stored in the storages system.
 */
export const zeroWorkflows = pgTable(
  "zero_workflows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    visibility: varchar("visibility", { length: 16 })
      .$type<ZeroWorkflowVisibility>()
      .notNull()
      .default("private"),
    ownerUserId: text("owner_user_id").notNull(),
    displayName: varchar("display_name", { length: 256 }),
    description: text("description"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return {
      orgNameIdx: uniqueIndex("idx_zero_workflows_org_name").on(
        table.orgId,
        table.name,
      ),
      orgIdx: index("idx_zero_workflows_org").on(table.orgId),
      ownerIdx: index("idx_zero_workflows_org_owner").on(
        table.orgId,
        table.ownerUserId,
      ),
    };
  },
);

/**
 * Workflow-agent attachments.
 *
 * Sparse model: presence of a row means the workflow is attached to the agent.
 * Runtime loading still filters these rows by current-user workflow visibility.
 */
export const zeroWorkflowAgents = pgTable(
  "zero_workflow_agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(
        () => {
          return zeroWorkflows.id;
        },
        { onDelete: "cascade" },
      ),
    agentId: uuid("agent_id")
      .notNull()
      .references(
        () => {
          return zeroAgents.id;
        },
        { onDelete: "cascade" },
      ),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return {
      workflowAgentIdx: uniqueIndex(
        "idx_zero_workflow_agents_workflow_agent",
      ).on(table.workflowId, table.agentId),
      agentIdx: index("idx_zero_workflow_agents_agent").on(
        table.orgId,
        table.agentId,
      ),
      workflowIdx: index("idx_zero_workflow_agents_workflow").on(
        table.orgId,
        table.workflowId,
      ),
    };
  },
);
