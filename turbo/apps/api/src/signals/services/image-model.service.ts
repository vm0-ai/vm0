/**
 * Resolves the built-in image model default snapshotted onto a run.
 *
 * Image model selection is dormant while its feature switch is disabled. Once
 * enabled, the chain is thread pin, then member default, then the catalog
 * default. The run row owns the result so later preference changes cannot
 * affect an in-flight run.
 */
import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  DEFAULT_IMAGE_MODEL,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, eq } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

function catalogedImageModel(
  value: string | null | undefined,
): ImageModel | null {
  return isImageModelId(value) ? value : null;
}

async function threadImageModel(
  db: ReadonlyDb,
  chatThreadId: string,
): Promise<ImageModel | null> {
  const [thread] = await db
    .select({ selectedImageModel: chatThreads.selectedImageModel })
    .from(chatThreads)
    .where(eq(chatThreads.id, chatThreadId))
    .limit(1);
  return catalogedImageModel(thread?.selectedImageModel);
}

async function memberImageModel(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<ImageModel | null> {
  const [member] = await db
    .select({ selectedImageModel: orgMembersMetadata.selectedImageModel })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    )
    .limit(1);
  return catalogedImageModel(member?.selectedImageModel);
}

export async function resolveImageModelForRun(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<ImageModel | null> {
  if (
    !isFeatureEnabled(
      FeatureSwitchKey.ImageModelSelection,
      args.featureSwitchContext,
    )
  ) {
    return null;
  }

  if (args.chatThreadId !== undefined) {
    const threadPin = await threadImageModel(args.db, args.chatThreadId);
    if (threadPin !== null) {
      return threadPin;
    }
  }

  const memberDefault = await memberImageModel(
    args.db,
    args.orgId,
    args.userId,
  );
  return memberDefault ?? DEFAULT_IMAGE_MODEL;
}
