import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  boolean,
  index,
} from "drizzle-orm/pg-core";

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
 * Compose Jobs table
 * Tracks async compose-from-github operations
 * Jobs are retained for 24 hours then cleaned up
 */
export const composeJobs = pgTable(
  "compose_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(), // Clerk user ID
    githubUrl: text("github_url").notNull(),
    overwrite: boolean("overwrite").default(false).notNull(),
    // pending -> running -> completed | failed
    status: varchar("status", { length: 20 }).notNull(),
    sandboxId: varchar("sandbox_id", { length: 255 }),
    result: jsonb("result").$type<ComposeJobResult>(),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    // Index for finding active jobs by user (idempotency check)
    index("idx_compose_jobs_user_status").on(table.userId, table.status),
    // Index for cleanup job (finding old jobs)
    index("idx_compose_jobs_created").on(table.createdAt),
  ],
);
