import { command } from "ccstate";
import { eq, sql } from "drizzle-orm";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import {
  RUN_UPLOADED_FILE_SOURCES,
  runUploadedFiles,
  type RunUploadedFileSource,
} from "@vm0/db/schema/run-uploaded-file";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";

interface RecordWebUploadedFileArgs {
  readonly runId: string | undefined;
  readonly externalId: string;
  readonly userId: string;
  readonly orgId: string | null | undefined;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly s3Key: string;
  readonly metadata: Record<string, unknown>;
}

function isRunUploadedFileSource(
  source: string | null | undefined,
): source is RunUploadedFileSource {
  if (!source) {
    return false;
  }
  return RUN_UPLOADED_FILE_SOURCES.some((candidate) => {
    return candidate === source;
  });
}

/**
 * Insert (or upsert) a `run_uploaded_files` row for a successful web
 * upload, then publish the chat-thread artifacts-changed signal if the
 * run is linked to a thread. No-op when `runId` is undefined (ordinary
 * session callers without a run-scoped token).
 *
 * Verbatim port of apps/web/src/lib/zero/uploads/run-uploaded-files.ts.
 * Idempotency contract is upsert on (runId, source, externalId).
 */
export const recordWebUploadedFile$ = command(
  async (
    { set },
    args: RecordWebUploadedFileArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.runId) {
      return;
    }
    const writeDb = set(writeDb$);

    // Resolve `source` via zero_runs.trigger_source if it's a known value;
    // else fall back to "web". Mirrors web's resolveRunUploadedFileSource.
    const [run] = await writeDb
      .select({ triggerSource: zeroRuns.triggerSource })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, args.runId))
      .limit(1);
    signal.throwIfAborted();
    const source: RunUploadedFileSource = isRunUploadedFileSource(
      run?.triggerSource,
    )
      ? run.triggerSource
      : "web";

    const metadata = {
      ...args.metadata,
      s3Key: args.s3Key,
    };

    await writeDb
      .insert(runUploadedFiles)
      .values({
        runId: args.runId,
        source,
        externalId: args.externalId,
        userId: args.userId,
        orgId: args.orgId ?? null,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
        url: args.url,
        metadata,
      })
      .onConflictDoUpdate({
        target: [
          runUploadedFiles.runId,
          runUploadedFiles.source,
          runUploadedFiles.externalId,
        ],
        set: {
          userId: args.userId,
          orgId: args.orgId ?? null,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata,
          updatedAt: sql`now()`,
        },
      });
    signal.throwIfAborted();

    // Resolve chat-thread linkage, then publish.
    // Try zero_runs.chatThreadId first.
    const [zeroRunThread] = await writeDb
      .select({
        chatThreadId: zeroRuns.chatThreadId,
        userId: chatThreads.userId,
      })
      .from(zeroRuns)
      .innerJoin(chatThreads, eq(zeroRuns.chatThreadId, chatThreads.id))
      .where(eq(zeroRuns.id, args.runId))
      .limit(1);
    signal.throwIfAborted();

    if (zeroRunThread?.chatThreadId) {
      await publishUserSignal(
        [zeroRunThread.userId],
        `chatThreadArtifactsChanged:${zeroRunThread.chatThreadId}`,
      );
      signal.throwIfAborted();
      return;
    }

    // Fallback: chat_messages.runId join.
    const [messageThread] = await writeDb
      .select({
        chatThreadId: chatMessages.chatThreadId,
        userId: chatThreads.userId,
      })
      .from(chatMessages)
      .innerJoin(chatThreads, eq(chatMessages.chatThreadId, chatThreads.id))
      .where(eq(chatMessages.runId, args.runId))
      .limit(1);
    signal.throwIfAborted();

    if (messageThread) {
      await publishUserSignal(
        [messageThread.userId],
        `chatThreadArtifactsChanged:${messageThread.chatThreadId}`,
      );
      signal.throwIfAborted();
    }
  },
);
