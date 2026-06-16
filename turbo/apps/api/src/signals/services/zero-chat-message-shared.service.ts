import { command, computed, type Computed } from "ccstate";
import type { ResolvedAttachFile } from "@vm0/api-contracts/contracts/chat-threads";
import {
  chatMessages,
  type ChatMessageAttachFileMetadata,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { eq, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import {
  buildArtifactPrefix,
  buildFileUrl,
  buildFileUrlFromKey,
} from "../../lib/file-url";
import { writeDb$, type Db } from "../external/db";
import {
  publishThreadListChanged,
  publishUserSignal,
} from "../external/realtime";
import { listS3Objects } from "../external/s3";
import { assistantMessageIdForRunEvent } from "./assistant-message-id";

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
  tx: Pick<Db, "update">,
  threadId: string,
): Promise<void> {
  await tx
    .update(chatThreads)
    .set({
      lastMessageAt: sql`GREATEST(${chatThreads.lastMessageAt}, NOW())`,
    })
    .where(eq(chatThreads.id, threadId));
}

export function visibleChatMessageCondition() {
  return sql<boolean>`NOT EXISTS (
      SELECT 1
      FROM ${chatMessages} AS revoker
      WHERE revoker.revokes_message_id = ${chatMessages.id}
    )
    AND NOT (
      ${chatMessages.role} = 'user'
      AND ${chatMessages.runId} IS NULL
      AND ${chatMessages.revokesMessageId} IS NOT NULL
      AND ${chatMessages.content} IS NULL
      AND ${chatMessages.error} IS NULL
    )
    AND NOT (
      ${chatMessages.role} = 'user'
      AND ${chatMessages.runId} IS NULL
      AND ${chatMessages.interruptsRunId} IS NOT NULL
    )`;
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

  const deterministicRows =
    itemsWithRunEventId.length === 0
      ? []
      : await writeDb
          .insert(chatMessages)
          .values(
            itemsWithRunEventId.map((item) => {
              return {
                id: assistantMessageIdForRunEvent(args.runId, item.runEventId),
                chatThreadId: args.threadId,
                runId: args.runId,
                role: "assistant",
                content: item.content,
                sequenceNumber: item.sequenceNumber,
                runEventId: item.runEventId,
              };
            }),
          )
          .onConflictDoNothing()
          .returning({ id: chatMessages.id });
  signal.throwIfAborted();

  const legacyRows =
    legacyItems.length === 0
      ? []
      : await writeDb
          .insert(chatMessages)
          .values(
            legacyItems.map((item) => {
              return {
                chatThreadId: args.threadId,
                runId: args.runId,
                role: "assistant",
                content: item.content,
                sequenceNumber: item.sequenceNumber,
                runEventId: null,
              };
            }),
          )
          .onConflictDoNothing({
            target: [chatMessages.runId, chatMessages.sequenceNumber],
          })
          .returning({ id: chatMessages.id });
  signal.throwIfAborted();

  const insertedRowCount = deterministicRows.length + legacyRows.length;

  if (insertedRowCount > 0) {
    await publishUserSignal(
      [args.userId],
      `chatThreadMessageCreated:${args.threadId}`,
    );
    signal.throwIfAborted();

    await publishThreadListChanged(args.userId);
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
