import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const archivedTaskRuns = pgTable(
  "archived_task_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    taskId: text("task_id").notNull(),
    taskType: text("task_type").notNull(),
    // The latestRunId at archive time. If null, archives tasks with no run (e.g. schedules).
    // Archive is invalidated when the task's latestRunId differs from this value.
    archivedRunId: text("archived_run_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_archived_task_runs_unique").on(
        table.userId,
        table.orgId,
        table.taskId,
        table.taskType,
      ),
    ];
  },
);
