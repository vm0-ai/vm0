import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

/**
 * Agent Run Queue table
 * Temporary storage for runs waiting on concurrency slots.
 * Stores encrypted CreateRunParams (including secrets).
 * Records are deleted after dequeue — secrets never persist long-term.
 * Follows the same pattern as runner_job_queue.
 */
export const agentRunQueue = pgTable(
  "agent_run_queue",
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

    // Denormalized for efficient per-user queue queries
    userId: text("user_id").notNull(),

    // Denormalized for efficient per-org queue queries (partition key for dequeue)
    orgId: text("org_id").notNull(),

    // AES-256-GCM encrypted CreateRunParams JSON
    encryptedParams: text("encrypted_params"),

    // Lifecycle management
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(), // TTL for auto-cleanup
  },
  (table) => {
    return [
      // Index for per-user FIFO dequeue (kept for backward compatibility)
      index("agent_run_queue_user_created_idx").on(
        table.userId,
        table.createdAt,
      ),
      // Index for per-org FIFO dequeue (primary partition key)
      index("agent_run_queue_org_created_idx").on(table.orgId, table.createdAt),
      // Index for TTL cleanup
      index("agent_run_queue_expires_at_idx").on(table.expiresAt),
    ];
  },
);
