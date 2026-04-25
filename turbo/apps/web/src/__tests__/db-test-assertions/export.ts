import { eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { exportJobs } from "@vm0/db/schema/export-job";

/**
 * Find an export job by ID.
 * Returns the full row or null if not found.
 */
export async function findTestExportJobById(id: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(exportJobs)
    .where(eq(exportJobs.id, id))
    .limit(1);
  return row ?? null;
}
