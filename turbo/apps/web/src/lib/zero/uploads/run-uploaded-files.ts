import { sql } from "drizzle-orm";
import {
  runUploadedFiles,
  type RunUploadedFileSource,
} from "@vm0/db/schema/run-uploaded-file";

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
