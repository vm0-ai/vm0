import { storageVersions } from "@vm0/db/schema/storage";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * Back-date a committed storage version's `created_at`.
 *
 * Storage versions committed through the product upload API
 * (`POST /api/storages/prepare` + `POST /api/storages/commit`) get their
 * `created_at` from the database clock (`defaultNow()`), so neither `mockNow`
 * nor any product API can place a version on a specific historical day. The
 * memory summarize cron buckets versions into local calendar days by
 * `created_at`, so tests that exercise day bucketing and the seven-day
 * backfill must rewrite this one column after a real product commit.
 *
 * Version ids are content hashes salted with the storage row's random UUID,
 * so a version id uniquely identifies one row.
 */
export async function backdateStorageVersion(
  versionId: string,
  createdAt: Date,
): Promise<void> {
  await db()
    .update(storageVersions)
    .set({ createdAt })
    .where(eq(storageVersions.id, versionId));
}
