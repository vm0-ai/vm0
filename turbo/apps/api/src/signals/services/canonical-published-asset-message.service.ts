import { chatMessages } from "@vm0/db/schema/chat-message";
import {
  CANONICAL_ASSET_VERSION,
  chatMessageAssetRefs,
  runUploadedFiles,
} from "@vm0/db/schema/run-uploaded-file";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";

import type { Db } from "../external/db";
import { publishedOutputMessageIdForRun } from "./assistant-message-id";
import { insertChatMessage } from "./zero-chat-message.service";

type ChatMessageWriteTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

interface AttachCanonicalPublishedAssetsArgs {
  readonly runId: string;
  readonly threadId: string;
  readonly runGroupId: string | undefined;
  readonly createdAt: Date;
}

export async function attachCanonicalPublishedAssetsToAssistantResponse(
  tx: ChatMessageWriteTransaction,
  args: AttachCanonicalPublishedAssetsArgs,
): Promise<void> {
  const assets = await tx
    .select({ id: runUploadedFiles.id })
    .from(runUploadedFiles)
    .where(
      and(
        eq(runUploadedFiles.runId, args.runId),
        eq(runUploadedFiles.chatThreadId, args.threadId),
        eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
        eq(runUploadedFiles.classification, "published-output"),
        eq(runUploadedFiles.accessLevel, "published"),
      ),
    )
    .orderBy(asc(runUploadedFiles.createdAt), asc(runUploadedFiles.id));
  if (assets.length === 0) {
    return;
  }

  const [latestResponse] = await tx
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, args.threadId),
        eq(chatMessages.runId, args.runId),
        eq(chatMessages.role, "assistant"),
        isNotNull(chatMessages.content),
        isNotNull(chatMessages.sequenceNumber),
      ),
    )
    .orderBy(desc(chatMessages.sequenceNumber), desc(chatMessages.seqId))
    .limit(1);

  const attachmentOnlyMessageId = publishedOutputMessageIdForRun(args.runId);
  const responseMessageId =
    latestResponse?.id ??
    (
      await insertChatMessage(
        tx,
        {
          id: attachmentOnlyMessageId,
          chatThreadId: args.threadId,
          role: "assistant",
          content: null,
          runId: args.runId,
          runGroupId: args.runGroupId,
          createdAt: args.createdAt,
        },
        "id",
      )
    )?.id ??
    attachmentOnlyMessageId;

  await tx
    .insert(chatMessageAssetRefs)
    .values(
      assets.map((asset, position) => {
        return {
          chatMessageId: responseMessageId,
          assetId: asset.id,
          position,
        };
      }),
    )
    .onConflictDoNothing();
}
