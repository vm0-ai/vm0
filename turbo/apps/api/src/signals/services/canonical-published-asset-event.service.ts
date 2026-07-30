import {
  CANONICAL_ASSET_VERSION,
  chatEventAssetRefs,
  runUploadedFiles,
} from "@vm0/db/schema/run-uploaded-file";
import { and, asc, eq } from "drizzle-orm";

import type { Db } from "../external/db";

type ChatEventWriteTransaction = Parameters<
  Parameters<Db["transaction"]>[0]
>[0];

interface AttachCanonicalPublishedAssetsArgs {
  readonly runId: string;
  readonly threadId: string;
  readonly completedEventId: string;
}

export async function attachCanonicalPublishedAssetsToCompletionEvent(
  tx: ChatEventWriteTransaction,
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

  await tx
    .insert(chatEventAssetRefs)
    .values(
      assets.map((asset, position) => {
        return {
          chatEventId: args.completedEventId,
          assetId: asset.id,
          position,
        };
      }),
    )
    .onConflictDoNothing();
}
