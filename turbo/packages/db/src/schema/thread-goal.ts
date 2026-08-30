import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  uniqueIndex,
  index,
  check,
  foreignKey,
  integer,
} from "drizzle-orm/pg-core";
import { agents } from "./agent";
import { chatThreads } from "./chat-thread";

export type ThreadGoalStatus = "active" | "paused" | "blocked" | "complete";

export const threadGoals = pgTable(
  "thread_goals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      ),
    status: varchar("status", { length: 16 })
      .$type<ThreadGoalStatus>()
      .notNull(),
    objective: text("objective").notNull(),
    objectiveBrief: text("objective_brief").notNull(),
    autonomyBudget: integer("autonomy_budget").notNull().default(10),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "thread_goals_agent_id_agents_id_fk",
        columns: [table.agentId],
        foreignColumns: [agents.id],
      }).onDelete("cascade"),
      uniqueIndex("idx_thread_goals_chat_thread_unique").on(table.chatThreadId),
      index("idx_thread_goals_org_owner").on(table.orgId, table.ownerUserId),
      index("idx_thread_goals_org_status").on(table.orgId, table.status),
      check(
        "thread_goals_status_check",
        sql`status IN ('active', 'paused', 'blocked', 'complete')`,
      ),
      check(
        "thread_goals_autonomy_budget_check",
        sql`${table.autonomyBudget} BETWEEN 0 AND 10`,
      ),
    ];
  },
);
