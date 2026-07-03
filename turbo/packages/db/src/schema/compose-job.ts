import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Result object stored when compose job completes successfully
 */
export interface ComposeJobResult {
  composeId: string;
  composeName: string;
  versionId: string;
  warnings: string[];
}

/**
 * Compose job source — where the job was initiated from
 */
export type ComposeJobSource = "github" | "platform" | "slack";

/**
 * Compose Jobs table
 * Tracks async compose operations from any source (GitHub URL, platform UI, Slack)
 * Jobs are retained for 24 hours then cleaned up
 */
export const composeJobs = pgTable(
  "compose_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(), // Clerk user ID
    githubUrl: text("github_url"),
    overwrite: boolean("overwrite").default(false).notNull(),
    // Platform compose: the vm0.yaml content submitted from the UI
    content: jsonb("content"),
    // Platform compose: the instructions file content (e.g. CLAUDE.md)
    instructions: text("instructions"),
    // Where this job was initiated from
    source: varchar("source", { length: 20 })
      .notNull()
      .default("github")
      .$type<ComposeJobSource>(),
    // pending -> running -> completed | failed
    status: varchar("status", { length: 20 }).notNull(),
    sandboxId: varchar("sandbox_id", { length: 255 }),
    result: jsonb("result").$type<ComposeJobResult>(),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
  },
  (table) => {
    return [
      // Index for finding active jobs by user (idempotency check)
      index("idx_compose_jobs_user_status").on(table.userId, table.status),
      // Index for cleanup job (finding old jobs)
      index("idx_compose_jobs_created").on(table.createdAt),
      // Partial unique index: only one active (pending/running) job per user.
      // Enforces idempotency at the DB level, preventing TOCTOU races.
      uniqueIndex("idx_compose_jobs_user_active")
        .on(table.userId)
        .where(sql`status IN ('pending', 'running')`),
    ];
  },
);
