import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentRuns } from "./agent-run";
import type { RunnerJobQueueExecutionContext } from "@vm0/db/jsonb-contracts/runner-job-queue";

/**
 * Runner Job Queue table
 * Temporary storage for runner jobs with encrypted secrets
 * Records are deleted after job completion
 */
export const runnerJobQueue = pgTable(
  "runner_job_queue",
  {
    // Primary key, references agent_runs
    runId: uuid("run_id")
      .primaryKey()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),

    // Runner routing
    runnerGroup: varchar("runner_group", { length: 255 }).notNull(),
    profile: varchar("profile", { length: 255 })
      .notNull()
      .default("vm0/default"),

    // Claude/Codex CLI agent session id for affinity routing (nullable for
    // first-turn jobs before the guest reports a CLI agent session).
    cliAgentSessionId: varchar("session_id", { length: 255 }),

    // Claim status
    claimedAt: timestamp("claimed_at"),

    // Execution context (secrets encrypted with persistent-secret envelope)
    executionContext: jsonb("execution_context")
      .$type<RunnerJobQueueExecutionContext>()
      .notNull(),

    // Lifecycle management
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(), // TTL for auto-cleanup
  },
  (table) => {
    return [
      // Predicate-free index used by current poll queries.
      index("runner_job_queue_group_profile_idx").on(
        table.runnerGroup,
        table.profile,
      ),
      // Retained for previous API versions during rollout; remove in #21036.
      index("runner_job_queue_group_profile_unclaimed_idx")
        .on(table.runnerGroup, table.profile)
        .where(sql`claimed_at IS NULL`),
      // Index for session affinity routing on unclaimed jobs
      index("runner_job_queue_session_id_unclaimed_idx")
        .on(table.cliAgentSessionId)
        .where(sql`claimed_at IS NULL AND session_id IS NOT NULL`),
      // Index for TTL cleanup
      index("runner_job_queue_expires_at_idx").on(table.expiresAt),
    ];
  },
);
