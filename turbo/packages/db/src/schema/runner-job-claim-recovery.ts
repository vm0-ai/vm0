import {
  index,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { RunnerJobQueueExecutionContext } from "@okouai/db/jsonb-contracts/runner-job-queue";

import { agentRuns } from "./agent-run";

export const runnerJobClaimRecovery = pgTable(
  "runner_job_claim_recovery",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    reuseKey: varchar("reuse_key", { length: 263 }),
    executionContext: jsonb("execution_context")
      .$type<RunnerJobQueueExecutionContext>()
      .notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => {
    return [
      index("runner_job_claim_recovery_expires_at_idx").on(table.expiresAt),
    ];
  },
);
