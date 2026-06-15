import { index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

export const runBuiltInAdmissions = pgTable(
  "run_built_in_admissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    kind: varchar("kind", { length: 30 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => {
    return [
      index("idx_run_builtin_admissions_run_status").on(
        table.runId,
        table.status,
      ),
      index("idx_run_builtin_admissions_run_created").on(
        table.runId,
        table.createdAt,
      ),
      index("idx_run_builtin_admissions_expires_at").on(table.expiresAt),
    ];
  },
);
