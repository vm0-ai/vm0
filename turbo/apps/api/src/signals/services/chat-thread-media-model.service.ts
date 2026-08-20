/**
 * Resolves the media models a chat thread is pinned to when it is created.
 *
 * A thread stamps its video and image models the same way it stamps its run
 * model: once, at creation. An unpinned thread re-reads the member default on
 * every run, so changing that default later would retarget threads the user
 * had already started. Threads created before this pin existed still hold null
 * and keep falling through the member default in video-model.service and
 * image-model.service.
 */
import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import { isVideoModelId } from "@okouai/api-contracts/contracts/video-models";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

export interface NewChatThreadMediaModels {
  readonly selectedVideoModel: VideoModel;
  /**
   * Null while `ImageModelSelection` is off: the member cannot reach the image
   * picker yet, so there is no choice worth freezing. Those threads keep
   * resolving through the member default once the switch is turned on.
   */
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

/** Member default, then catalog default. */
export async function resolveNewChatThreadMediaModels(
  db: Pick<ReadonlyDb, "select">,
  args: { readonly orgId: string; readonly userId: string },
): Promise<NewChatThreadMediaModels> {
  const [member, featureSwitchContext] = await Promise.all([
    memberMediaModels(db, args),
    loadUserFeatureSwitchContext(db, args.orgId, args.userId),
  ]);
  const imageModelSelectionEnabled = isFeatureEnabled(
    FeatureSwitchKey.ImageModelSelection,
    featureSwitchContext,
  );
  return {
    selectedVideoModel: catalogedVideoModel(member.selectedVideoModel),
    selectedImageModel: imageModelSelectionEnabled
      ? catalogedImageModel(member.selectedImageModel)
      : null,
  };
}
