import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { storageVersions } from "./storage";

type StorageArchiveSizeBackfillOutcome = "missing" | "invalid" | "failed";

export const storageArchiveSizeBackfillWork = pgTable(
  "storage_archive_size_backfill_work",
  {
    storageVersionId: varchar("storage_version_id", { length: 64 })
      .primaryKey()
      .references(
        () => {
          return storageVersions.id;
        },
        { onDelete: "cascade" },
      ),
    claimToken: uuid("claim_token").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    lastAttemptAt: timestamp("last_attempt_at").notNull(),
    outcome: varchar("outcome", {
      length: 16,
    }).$type<StorageArchiveSizeBackfillOutcome>(),
    errorCode: varchar("error_code", { length: 64 }),
  },
  (table) => {
    return [
      check(
        "chk_storage_archive_size_backfill_work_attempt_count",
        sql`${table.attemptCount} > 0`,
      ),
      check(
        "chk_storage_archive_size_backfill_work_outcome",
        sql`${table.outcome} IS NULL OR ${table.outcome} IN ('missing', 'invalid', 'failed')`,
      ),
      check(
        "chk_storage_archive_size_backfill_work_error",
        sql`(${table.outcome} IS NULL AND ${table.errorCode} IS NULL)
          OR (${table.outcome} IS NOT NULL AND ${table.errorCode} IS NOT NULL)`,
      ),
    ];
  },
);
