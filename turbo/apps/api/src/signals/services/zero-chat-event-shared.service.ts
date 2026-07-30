import { command, computed, type Computed } from "ccstate";
import type { ResolvedAttachFile } from "@vm0/api-contracts/contracts/chat-threads";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  and,
  eq,
  isNotNull,
  isNull,
  not,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { writeDb$, type Db } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import { nowDate } from "../external/time";
import { resolvedArtifactObject } from "./artifact-storage.service";
import { assistantEventIdForRunEvent } from "./assistant-event-id";
import { insertChatEvents } from "./zero-chat-event.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";
import { publishFirstAssistantEventCreatedSafely } from "./zero-chat-first-assistant-event-metric.service";
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
const revoker = alias(chatEvents, "revoker");

export interface InsertAssistantEventsInput {
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

export function visibleChatEventCondition(
  db: Pick<Db, "select">,
): SQL | undefined {
  const isCompatibilityUserEvent = chatEventTypeIn([
    "input.prompt",
    "input.automation",
    "input.rejected",
    "control.interrupt",
    "control.revoke",
  ]);
  return and(
    not(chatEventTypeIn(["input.goal"])),
    notExists(
      db
        .select({ id: revoker.id })
        .from(revoker)
        .where(eq(revoker.revokesEventId, chatEvents.id)),
    ),
    or(
      not(isCompatibilityUserEvent),
      isNotNull(chatEvents.runId),
      isNull(chatEvents.revokesEventId),
      isNotNull(chatEvents.content),
      isNotNull(chatEvents.error),
    ),
    or(
      not(isCompatibilityUserEvent),
      isNotNull(chatEvents.runId),
      isNull(chatEvents.interruptsRunId),
    ),
  );
}

export function resolveAttachFileUrls(
  userId: string,
  fileIds: readonly string[],
): Computed<Promise<readonly ResolvedAttachFile[]>> {
  return computed(async (get): Promise<readonly ResolvedAttachFile[]> => {
    const resolved = await Promise.all(
      fileIds.map(async (fileId): Promise<ResolvedAttachFile | null> => {
        const object = await get(resolvedArtifactObject(userId, fileId));
        if (!object) {
          return null;
        }

        return {
          id: fileId,
          filename: object.filename,
          contentType: object.contentType,
          size: object.size,
          url: object.url,
        };
      }),
    );

    return resolved.filter((file): file is ResolvedAttachFile => {
      return file !== null;
    });
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

async function assistantEventRunContextForRun(
  db: ChatThreadEventTransaction,
  runId: string,
): Promise<{
  readonly runGroupId: string | undefined;
  readonly shouldAttemptFirstAssistantEventClaim: boolean;
}> {
  const [run] = await db
    .select({
      runGroupId: zeroRuns.runGroupId,
      apiStartedAt: zeroRuns.apiStartedAt,
      firstAssistantEventAcknowledgedAt:
        zeroRuns.firstAssistantEventAcknowledgedAt,
    })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return {
    runGroupId: run?.runGroupId ?? undefined,
    shouldAttemptFirstAssistantEventClaim:
      run !== undefined &&
      run.apiStartedAt !== null &&
      run.firstAssistantEventAcknowledgedAt === null,
  };
}

interface InsertAssistantEventsTransactionResult {
  readonly insertedRowCount: number;
  readonly shouldAttemptFirstAssistantEventClaim: boolean;
}

export async function insertAssistantEventsInTransaction(
  tx: ChatThreadEventTransaction,
  args: InsertAssistantEventsInput,
  signal: AbortSignal,
): Promise<InsertAssistantEventsTransactionResult> {
  if (args.items.length === 0) {
    return {
      insertedRowCount: 0,
      shouldAttemptFirstAssistantEventClaim: false,
    };
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
  const runContext = await assistantEventRunContextForRun(tx, args.runId);
  signal.throwIfAborted();

  const deterministicRows =
    itemsWithRunEventId.length === 0
      ? []
      : await insertChatEvents(
          tx,
          itemsWithRunEventId.map((item) => {
            return {
              id: assistantEventIdForRunEvent(args.runId, item.runEventId),
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
  signal.throwIfAborted();

  const insertedRowCount = deterministicRows.length + legacyRows.length;
  return {
    insertedRowCount,
    shouldAttemptFirstAssistantEventClaim:
      runContext.shouldAttemptFirstAssistantEventClaim,
  };
}

export async function insertAssistantEvents(
  writeDb: Db,
  args: InsertAssistantEventsInput,
  signal: AbortSignal,
): Promise<number> {
  if (args.items.length === 0) {
    return 0;
  }

  const result = await writeDb.transaction(async (tx) => {
    return await insertAssistantEventsInTransaction(tx, args, signal);
  });
  signal.throwIfAborted();

  if (result.insertedRowCount > 0) {
    if (result.shouldAttemptFirstAssistantEventClaim) {
      await publishFirstAssistantEventCreatedSafely({
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

  return result.insertedRowCount;
}

export const insertAssistantEvents$ = command(
  async (
    { set },
    args: InsertAssistantEventsInput,
    signal: AbortSignal,
  ): Promise<number> => {
    return await insertAssistantEvents(set(writeDb$), args, signal);
  },
);
