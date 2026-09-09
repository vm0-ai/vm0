import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { RunActivityEntries } from "@okouai/db/jsonb-contracts/run-activity-snapshot";
import { agentRuns } from "./agent-run";

export const runActivitySnapshots = pgTable(
  "run_activity_snapshots",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    entries: jsonb("entries").$type<RunActivityEntries>().notNull().default([]),
    activityRevision: text("activity_revision").notNull().default("empty"),
    messageCursor: bigint("message_cursor", { mode: "number" })
      .notNull()
      .default(0),
    expiresAt: timestamp("expires_at")
      .notNull()
      .default(sql`(now() AT TIME ZONE 'UTC') + interval '24 hours'`),
    summary: text("summary"),
    summaryRevision: text("summary_revision"),
    summarySequence: bigint("summary_sequence", { mode: "number" }),
    summaryMessageCursor: bigint("summary_message_cursor", { mode: "number" }),
    summarizedAt: timestamp("summarized_at"),
    nextAttemptAt: timestamp("next_attempt_at"),
    claimId: uuid("claim_id"),
    claimRevision: text("claim_revision"),
    claimExpiresAt: timestamp("claim_expires_at"),
  },
  (table) => {
    return [
      index("run_activity_snapshots_expiry_idx").on(
        table.expiresAt,
        table.runId,
      ),
      check(
        "run_activity_snapshots_entries_bound",
        sql`jsonb_typeof(${table.entries}) = 'array' AND jsonb_array_length(${table.entries}) <= 16 AND octet_length(${table.entries}::text) <= 16384`,
      ),
    ];
  },
);
