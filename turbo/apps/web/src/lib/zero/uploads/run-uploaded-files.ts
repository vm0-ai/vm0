import { sql } from "drizzle-orm";
import {
  runUploadedFiles,
  type RunUploadedFileSource,
} from "@vm0/db/schema/run-uploaded-file";
import { logger } from "../../shared/logger";

const log = logger("zero:uploads:run-uploaded-files");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RecordRunUploadedFileParams = {
  runId: string | undefined;
  source: RunUploadedFileSource;
  externalId: string;
  userId: string;
  orgId?: string | null;
  filename?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  url?: string | null;
  metadata?: Record<string, unknown>;
};

export async function recordRunUploadedFile({
  runId,
  source,
  externalId,
  userId,
  orgId,
  filename,
  contentType,
  sizeBytes,
  url,
  metadata,
}: RecordRunUploadedFileParams): Promise<void> {
  if (!runId) return;

  if (!UUID_PATTERN.test(runId)) {
    log.warn("Skipping uploaded-file association for non-UUID run id", {
      runId,
      source,
      externalId,
    });
    return;
  }

  await globalThis.services.db
    .insert(runUploadedFiles)
    .values({
      runId,
      source,
      externalId,
      userId,
      orgId: orgId ?? null,
      filename: filename ?? null,
      contentType: contentType ?? null,
      sizeBytes: sizeBytes ?? null,
      url: url ?? null,
      metadata: metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [
        runUploadedFiles.runId,
        runUploadedFiles.source,
        runUploadedFiles.externalId,
      ],
      set: {
        userId,
        orgId: orgId ?? null,
        filename: filename ?? null,
        contentType: contentType ?? null,
        sizeBytes: sizeBytes ?? null,
        url: url ?? null,
        metadata: metadata ?? {},
        updatedAt: sql`now()`,
      },
    });
}
