/**
 * Resolves the media models a chat thread is pinned to when it is created.
 *
 * A thread stamps its video and image models the same way it stamps its run
 * model: once, at creation. An unpinned thread re-reads the member default on
 * every run, so changing that default later would retarget threads the user
 * had already started. Threads created before this pin existed still hold null
 * and keep falling through the member default in run-media-model.service.
 */
import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import { isVideoModelId } from "@okouai/api-contracts/contracts/video-models";
import {
  DEFAULT_IMAGE_MODEL,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import {
  DEFAULT_VIDEO_MODEL,
  type VideoModel,
} from "@okouai/core/video-model-catalog";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

export interface NewChatThreadMediaModels {
  readonly selectedVideoModel: VideoModel | null;
  readonly selectedImageModel: ImageModel | null;
}

/**
 * A stored id that has left its catalog counts as unset, matching how dispatch
 * narrows an existing pin.
 */
function catalogedVideoModel(value: string | null): VideoModel {
  return isVideoModelId(value) ? value : DEFAULT_VIDEO_MODEL;
}

function catalogedImageModel(value: string | null): ImageModel {
  return isImageModelId(value) ? value : DEFAULT_IMAGE_MODEL;
}

async function memberMediaModels(
  db: Pick<ReadonlyDb, "select">,
  args: { readonly orgId: string; readonly userId: string },
): Promise<{
  readonly selectedVideoModel: string | null;
  readonly selectedImageModel: string | null;
}> {
  const [member] = await db
    .select({
      selectedVideoModel: orgMembersMetadata.selectedVideoModel,
      selectedImageModel: orgMembersMetadata.selectedImageModel,
    })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, args.orgId),
        eq(orgMembersMetadata.userId, args.userId),
      ),
    )
    .limit(1);
  return {
    selectedVideoModel: member?.selectedVideoModel ?? null,
    selectedImageModel: member?.selectedImageModel ?? null,
  };
}

/** Member default, then catalog default, for both media pickers. */
export async function loadNewChatThreadMediaModels(
  db: Pick<ReadonlyDb, "select">,
  args: { readonly orgId: string; readonly userId: string },
): Promise<NewChatThreadMediaModels> {
  const member = await memberMediaModels(db, args);
  return {
    selectedVideoModel: catalogedVideoModel(member.selectedVideoModel),
    selectedImageModel: catalogedImageModel(member.selectedImageModel),
  };
}
