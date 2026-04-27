import { and, eq } from "drizzle-orm";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { initServices } from "../../lib/init-services";

type RunUploadedFile = typeof runUploadedFiles.$inferSelect;

/**
 * @why-db-direct Test assertion helper for upload/run association rows.
 * No user-facing API exposes this table yet.
 */
export async function findTestRunUploadedFiles(
  source: string,
  externalId: string,
): Promise<RunUploadedFile[]> {
  initServices();
  return await globalThis.services.db
    .select()
    .from(runUploadedFiles)
    .where(
      and(
        eq(runUploadedFiles.source, source),
        eq(runUploadedFiles.externalId, externalId),
      ),
    );
}

/**
 * @why-db-direct Test assertion helper for upload/run association rows.
 * No user-facing API exposes this table yet.
 */
export async function findTestRunUploadedFilesByRun(params: {
  runId: string;
  source: string;
  externalId: string;
}): Promise<RunUploadedFile[]> {
  initServices();
  return await globalThis.services.db
    .select()
    .from(runUploadedFiles)
    .where(
      and(
        eq(runUploadedFiles.runId, params.runId),
        eq(runUploadedFiles.source, params.source),
        eq(runUploadedFiles.externalId, params.externalId),
      ),
    );
}
