import { initServices } from "../../lib/init-services";
import { exportJobs } from "@vm0/db/schema/export-job";

/**
 * Insert a test export job for a specific org.
 *
 * @why-db-direct Export jobs are normally created via async workflow, not an
 * API endpoint. Tests need to control the exact state (status, s3Key) for
 * deletion and cleanup verification.
 */
export async function insertTestExportJob(
  orgId: string,
  options: {
    userId: string;
    status: string;
    s3Key?: string | null;
    completedAt?: Date | null;
    expiresAt?: Date | null;
    error?: string | null;
  },
): Promise<{ id: string }> {
  initServices();
  const [row] = await globalThis.services.db
    .insert(exportJobs)
    .values({
      orgId,
      userId: options.userId,
      status: options.status,
      s3Key: options.s3Key ?? null,
      completedAt: options.completedAt ?? null,
      expiresAt: options.expiresAt ?? null,
      error: options.error ?? null,
    })
    .returning({ id: exportJobs.id });
  return row!;
}
