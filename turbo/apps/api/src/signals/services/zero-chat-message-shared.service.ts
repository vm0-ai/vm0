import { command, computed, type Computed } from "ccstate";
import type { ResolvedAttachFile } from "@vm0/api-contracts/contracts/chat-threads";
import {
  chatMessages,
  type ChatMessageAttachFileMetadata,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { eq, isNotNull, isNull, not, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { env } from "../../lib/env";
import {
  buildArtifactPrefix,
  buildFileUrl,
  buildFileUrlFromKey,
} from "../../lib/file-url";
import { writeDb$, type Db } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import { listS3Objects } from "../external/s3";
import { nowDate } from "../external/time";
import { assistantMessageIdForRunEvent } from "./assistant-message-id";
import { insertChatEvents } from "./zero-chat-event.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";
import { publishFirstAssistantMessageCreatedSafely } from "./zero-chat-first-assistant-message-metric.service";
import {
  appendChatThreadEvent,
  type ChatThreadEventTransaction,
} from "./zero-chat-thread-event.service";

const EXT_MIMETYPE_MAP: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  mpga: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
};
const revoker = alias(chatMessages, "revoker");

interface InsertAssistantEventMessagesInput {
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly items: readonly {
    readonly sequenceNumber: number;
    readonly content: string;
    readonly runEventId?: string;
  }[];
}

export function inferMimetype(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext
    ? (EXT_MIMETYPE_MAP[ext] ?? "application/octet-stream")
    : "application/octet-stream";
}

export async function touchChatThreadLastMessageAt(
  tx: ChatThreadEventTransaction,
  threadId: string,
  touchedAt: Date = nowDate(),
  eventId?: string,
): Promise<void> {
  const [thread] = await tx
    .update(chatThreads)
    .set({
      lastMessageAt: sql`GREATEST(${chatThreads.lastMessageAt}, ${touchedAt})`,
    })
    .where(eq(chatThreads.id, threadId))
    .returning({
      id: chatThreads.id,
      userId: chatThreads.userId,
      agentComposeId: chatThreads.agentComposeId,
      lastMessageAt: chatThreads.lastMessageAt,
    });
  if (!thread) {
    return;
  }
  await appendChatThreadEvent(tx, {
    kind: "sort_touched",
    userId: thread.userId,
    chatThreadId: thread.id,
    agentComposeId: thread.agentComposeId,
    eventId,
    createdAt: thread.lastMessageAt,
  });
}

export function visibleChatEventCondition(db: Pick<Db, "select">) {
  const isCompatibilityUserEvent = chatEventTypeIn([
    "input.prompt",
    "input.automation",
    "input.rejected",
    "control.interrupt",
    "control.revoke",
  ]);
  return sql.join(
    [
      not(chatEventTypeIn(["input.goal"])),
      notExists(
        db
          .select({ id: revoker.id })
          .from(revoker)
          .where(eq(revoker.revokesEventId, chatMessages.id)),
      ),
      or(
        not(isCompatibilityUserEvent),
        isNotNull(chatMessages.runId),
        isNull(chatMessages.revokesEventId),
        isNotNull(chatMessages.content),
        isNotNull(chatMessages.error),
      ),
      or(
        not(isCompatibilityUserEvent),
        isNotNull(chatMessages.runId),
        isNull(chatMessages.interruptsRunId),
      ),
    ],
    sql` AND `,
  );
}

export function resolveAttachFileUrls(
  userId: string,
  fileIds: readonly string[],
): Computed<Promise<readonly ResolvedAttachFile[]>> {
  return computed(async (get): Promise<readonly ResolvedAttachFile[]> => {
    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    const resolved = await Promise.all(
      fileIds.map(async (fileId): Promise<ResolvedAttachFile | null> => {
        const prefix = buildArtifactPrefix(userId, fileId);
        const objects = await get(listS3Objects(bucket, prefix));
        const object = objects[0];
        if (!object) {
          return null;
        }

        const filename = object.key.split("/").pop() ?? fileId;
        return {
          id: fileId,
          filename,
          contentType: inferMimetype(filename),
          size: object.size,
          url: buildFileUrl(userId, fileId, filename),
        };
      }),
    );

    return resolved.filter((file): file is ResolvedAttachFile => {
      return file !== null;
    });
  });
}

export function resolveAttachFileMetadataUrls(
  metadata: readonly ChatMessageAttachFileMetadata[],
): readonly ResolvedAttachFile[] {
  return metadata.map((file) => {
    return {
      id: file.id,
      filename: file.filename,
      contentType: file.contentType,
      size: file.size,
      url: buildFileUrlFromKey(file.objectKey),
    };
  });
}

export async function runGroupIdForRun(
  db: Db,
  runId: string,
): Promise<string | undefined> {
  const [run] = await db
    .select({ runGroupId: zeroRuns.runGroupId })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return run?.runGroupId ?? undefined;
}

async function assistantMessageRunContextForRun(
  db: Db,
  runId: string,
): Promise<{
  readonly runGroupId: string | undefined;
  readonly shouldAttemptFirstAssistantMessageClaim: boolean;
}> {
  const [run] = await db
    .select({
      runGroupId: zeroRuns.runGroupId,
      apiStartedAt: zeroRuns.apiStartedAt,
      firstAssistantMessageAcknowledgedAt:
        zeroRuns.firstAssistantMessageAcknowledgedAt,
    })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return {
    runGroupId: run?.runGroupId ?? undefined,
    shouldAttemptFirstAssistantMessageClaim:
      run !== undefined &&
      run.apiStartedAt !== null &&
      run.firstAssistantMessageAcknowledgedAt === null,
  };
}

export async function insertAssistantEventMessages(
  writeDb: Db,
  args: InsertAssistantEventMessagesInput,
  signal: AbortSignal,
): Promise<number> {
  if (args.items.length === 0) {
    return 0;
  }

  const itemsWithRunEventId = args.items.filter(
    (
      item,
    ): item is {
      readonly sequenceNumber: number;
      readonly content: string;
      readonly runEventId: string;
    } => {
      return item.runEventId !== undefined;
    },
  );
  const legacyItems = args.items.filter((item) => {
    return item.runEventId === undefined;
  });
  const runContext = await assistantMessageRunContextForRun(
    writeDb,
    args.runId,
  );

  const [deterministicRows, legacyRows] = await writeDb.transaction(
    async (tx) => {
      const deterministicRows =
        itemsWithRunEventId.length === 0
          ? []
          : await insertChatEvents(
              tx,
              itemsWithRunEventId.map((item) => {
                return {
                  id: assistantMessageIdForRunEvent(
                    args.runId,
                    item.runEventId,
                  ),
                  chatThreadId: args.threadId,
                  runId: args.runId,
                  runGroupId: runContext.runGroupId,
                  eventType: "output.message",
                  content: item.content,
                  sequenceNumber: item.sequenceNumber,
                  runEventId: item.runEventId,
                };
              }),
              "any",
            );
      signal.throwIfAborted();

      const legacyRows =
        legacyItems.length === 0
          ? []
          : await insertChatEvents(
              tx,
              legacyItems.map((item) => {
                return {
                  chatThreadId: args.threadId,
                  runId: args.runId,
                  runGroupId: runContext.runGroupId,
                  eventType: "output.message",
                  content: item.content,
                  sequenceNumber: item.sequenceNumber,
                  runEventId: null,
                };
              }),
              "run-sequence",
            );
      return [deterministicRows, legacyRows] as const;
    },
  );
  signal.throwIfAborted();

  const insertedRowCount = deterministicRows.length + legacyRows.length;

  if (insertedRowCount > 0) {
    if (runContext.shouldAttemptFirstAssistantMessageClaim) {
      await publishFirstAssistantMessageCreatedSafely({
        db: writeDb,
        userId: args.userId,
        threadId: args.threadId,
        runId: args.runId,
      });
    } else {
      await publishChatThreadMessageCreatedSafely(args.userId, args.threadId);
    }
    signal.throwIfAborted();

    await publishThreadListChangedSafely(args.userId);
    signal.throwIfAborted();
  }

  return insertedRowCount;
}

export const insertAssistantEventMessages$ = command(
  async (
    { set },
    args: InsertAssistantEventMessagesInput,
    signal: AbortSignal,
  ): Promise<number> => {
    return await insertAssistantEventMessages(set(writeDb$), args, signal);
  },
);
