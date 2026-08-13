/**
 * Resolves which built-in video model a run generates with.
 *
 * The chain is thread pin, then member default, then the catalog default. The
 * result is snapshotted onto the run row when the run is dispatched, so
 * re-pinning the thread mid-run cannot change what an in-flight run produces.
 */
import {
  DEFAULT_VIDEO_MODEL,
  VIDEO_MODEL_CONFIGS,
  type VideoModel,
} from "@okouai/core/video-model-catalog";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

/**
 * Stored pins are plain strings projected out of jsonb without being
 * re-validated against the current catalog, so a retired model id can outlive
 * its catalog entry. Treat one as unset and keep falling back instead of
 * failing the dispatch on data the user cannot reach any more.
 */
function catalogedVideoModel(
  value: string | null | undefined,
): VideoModel | null {
  if (value === undefined || value === null) {
    return null;
  }
  return value in VIDEO_MODEL_CONFIGS ? (value as VideoModel) : null;
}

async function threadVideoModel(
  db: ReadonlyDb,
  chatThreadId: string,
): Promise<VideoModel | null> {
  const [thread] = await db
    .select({ selectedVideoModel: chatThreads.selectedVideoModel })
    .from(chatThreads)
    .where(eq(chatThreads.id, chatThreadId))
    .limit(1);
  return catalogedVideoModel(thread?.selectedVideoModel);
}

async function memberVideoModel(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<VideoModel | null> {
  const [member] = await db
    .select({ selectedVideoModel: orgMembersMetadata.selectedVideoModel })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    )
    .limit(1);
  return catalogedVideoModel(member?.selectedVideoModel);
}

export async function resolveVideoModelForRun(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  /**
   * Undefined for triggers that own no chat thread, such as telegram. Those
   * runs skip the thread layer rather than failing to resolve.
   */
  readonly chatThreadId: string | undefined;
}): Promise<VideoModel> {
  const threadPin =
    args.chatThreadId === undefined
      ? null
      : await threadVideoModel(args.db, args.chatThreadId);
  if (threadPin) {
    return threadPin;
  }
  const memberDefault = await memberVideoModel(
    args.db,
    args.orgId,
    args.userId,
  );
  return memberDefault ?? DEFAULT_VIDEO_MODEL;
}
