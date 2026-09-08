import { exportJobs } from "@okouai/db/schema/export-job";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";

/** A historical export brand cannot be created by the current public API. */
export async function seedLegacyUserExportJobFixture(
  userId: string,
  jobId: string,
) {
  const [row] = await db()
    .update(exportJobs)
    .set({ publicBrand: "vm0" })
    .where(
      and(
        eq(exportJobs.id, jobId),
        eq(exportJobs.userId, userId),
        eq(exportJobs.status, "completed"),
      ),
    )
    .returning();
  if (!row) {
    throw new Error("Expected a test-owned completed export");
  }
  return row;
}

/** The public response omits the legacy brand and stored object identity. */
export async function readUserExportJobFixture(userId: string, jobId: string) {
  const [row] = await db()
    .select()
    .from(exportJobs)
    .where(and(eq(exportJobs.id, jobId), eq(exportJobs.userId, userId)));
  if (!row) {
    throw new Error("Expected a test-owned export");
  }
  return row;
}
