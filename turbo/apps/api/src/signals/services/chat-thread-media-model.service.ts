/**
 * Resolves the media models a chat thread is pinned to when it is created.
 *
 * A thread stamps its video and image models the same way it stamps its run
 * model: once, at creation. An unpinned thread re-reads the member default on
 * every run, so changing that default later would retarget threads the user
 * had already started. Threads created before this pin existed still hold null
 * and keep falling through the member default in video-model.service and
 * image-model.service.
 *
 * Each model is pinned only while its own picker exists. A member who cannot
 * reach the picker has no default of their own to freeze, so pinning would
 * only capture whichever catalog default happened to be current and stop that
 * thread from following the catalog. Written pins also survive a revert of this
 * code, so the switch is the containment for that too.
 */
import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import { isVideoModelId } from "@okouai/api-contracts/contracts/video-models";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
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

/**
 * Member default, then catalog default, for each picker that is switched on.
 * For callers that already resolved this request's feature switches.
 */
export async function resolveNewChatThreadMediaModels(
  db: Pick<ReadonlyDb, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
): Promise<NewChatThreadMediaModels> {
  const videoEnabled = isFeatureEnabled(
    FeatureSwitchKey.VideoModelSelection,
    args.featureSwitchContext,
  );
  const imageEnabled = isFeatureEnabled(
    FeatureSwitchKey.ImageModelSelection,
    args.featureSwitchContext,
  );
  if (!videoEnabled && !imageEnabled) {
    return { selectedVideoModel: null, selectedImageModel: null };
  }

  const member = await memberMediaModels(db, args);
  return {
    selectedVideoModel: videoEnabled
      ? catalogedVideoModel(member.selectedVideoModel)
      : null,
    selectedImageModel: imageEnabled
      ? catalogedImageModel(member.selectedImageModel)
      : null,
  };
}

/** For creation paths that carry no feature-switch context of their own. */
export async function loadNewChatThreadMediaModels(
  db: Pick<ReadonlyDb, "select">,
  args: { readonly orgId: string; readonly userId: string },
): Promise<NewChatThreadMediaModels> {
  return await resolveNewChatThreadMediaModels(db, {
    ...args,
    featureSwitchContext: await loadUserFeatureSwitchContext(
      db,
      args.orgId,
      args.userId,
    ),
  });
}
