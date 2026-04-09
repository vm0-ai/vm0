import { eq } from "drizzle-orm";
import { exportJobs } from "../../db/schema/export-job";

// ============================================================================
// Export Job Helpers
// ============================================================================

/**
 * Find an export job by ID.
 *
 * Direct DB read is required to verify job state after async export execution.
 */
export async function findTestExportJobById(id: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(exportJobs)
    .where(eq(exportJobs.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Insert a test export job for a specific org.
 *
 * Direct DB insert is required because export jobs are normally created
 * via async workflow, and tests need to control the exact state (status, s3Key).
 */
export async function insertTestExportJob(
  orgId: string,
  options: {
    userId: string;
    status: string;
    s3Key?: string | null;
  },
): Promise<{ id: string }> {
  const [row] = await globalThis.services.db
    .insert(exportJobs)
    .values({
      orgId,
      userId: options.userId,
      status: options.status,
      s3Key: options.s3Key ?? null,
    })
    .returning({ id: exportJobs.id });
  return row!;
}
