import { createHash } from "node:crypto";

import {
  IMAGE_REFERENCE_CONTENT_TYPES,
  type ImageReference,
  type ImageReferenceContentType,
  type ImageReferencePreviewAsset,
} from "@okouai/api-contracts/contracts/image-references";
import { imageReferences } from "@okouai/db/schema/image-reference";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { userCache } from "@okouai/db/schema/user-cache";
import { and, desc, eq, getTableColumns, inArray, or } from "drizzle-orm";
import { z } from "zod";

import type { ReadonlyDb } from "../external/db";

const IMAGE_REFERENCE_PREVIEW_ASSET_PREFIX = "irp:";
const imageReferenceColumns = getTableColumns(imageReferences);

type SelectedImageReferenceRow = typeof imageReferences.$inferSelect & {
  readonly sourceFilename: string | null;
  readonly sourceContentType: string | null;
  readonly sourceStorageKey: string | null;
  readonly creatorDisplayName: string | null;
  readonly creatorImageUrl: string | null;
};

export type ImageReferenceRow = typeof imageReferences.$inferSelect & {
  readonly sourceFilename: string;
  readonly sourceContentType: ImageReferenceContentType;
  readonly sourceStorageKey: string;
  readonly creatorDisplayName: string | null;
  readonly creatorImageUrl: string | null;
};

function isImageReferenceContentType(
  value: string,
): value is ImageReferenceContentType {
  const accepted: readonly string[] = IMAGE_REFERENCE_CONTENT_TYPES;
  return accepted.includes(value);
}

function validateSelectedRow(
  row: SelectedImageReferenceRow,
): ImageReferenceRow {
  if (
    !row.sourceFilename ||
    !row.sourceContentType ||
    !isImageReferenceContentType(row.sourceContentType) ||
    !row.sourceStorageKey
  ) {
    throw new Error(`Image reference ${row.id} has invalid source metadata`);
  }
  return {
    ...row,
    sourceFilename: row.sourceFilename,
    sourceContentType: row.sourceContentType,
    sourceStorageKey: row.sourceStorageKey,
  };
}

export function imageReferencePreviewAssetId(row: ImageReferenceRow): string {
  const storageVersionId = createHash("sha256")
    .update(row.sourceStorageKey)
    .digest("base64url");
  return `${IMAGE_REFERENCE_PREVIEW_ASSET_PREFIX}${row.id}:${storageVersionId}`;
}

interface ImageReferencePreviewAssetIdentity {
  readonly referenceId: string;
  readonly storageVersionId: string;
}

export function parseImageReferencePreviewAssetId(
  previewAssetId: string,
): ImageReferencePreviewAssetIdentity | null {
  if (!previewAssetId.startsWith(IMAGE_REFERENCE_PREVIEW_ASSET_PREFIX)) {
    return null;
  }
  const value = previewAssetId.slice(
    IMAGE_REFERENCE_PREVIEW_ASSET_PREFIX.length,
  );
  const separator = value.indexOf(":");
  if (separator === -1) {
    return null;
  }
  const referenceId = value.slice(0, separator);
  const storageVersionId = value.slice(separator + 1);
  if (
    !z.uuid().safeParse(referenceId).success ||
    !/^[\w-]{43}$/u.test(storageVersionId)
  ) {
    return null;
  }
  return { referenceId, storageVersionId };
}

export function imageReferenceResponse(args: {
  readonly row: ImageReferenceRow;
  readonly previewAsset: ImageReferencePreviewAsset;
  readonly userId: string;
  readonly isOrgAdmin: boolean;
}): ImageReference {
  return {
    id: args.row.id,
    title: args.row.title,
    visibility: args.row.visibility,
    ownerUserId: args.row.ownerUserId,
    creator: {
      userId: args.row.ownerUserId,
      displayName: args.row.creatorDisplayName,
      imageUrl: args.row.creatorImageUrl,
    },
    sourceFilename: args.row.sourceFilename,
    contentType: args.row.sourceContentType,
    width: args.row.width,
    height: args.row.height,
    previewAsset: args.previewAsset,
    canManage: args.row.ownerUserId === args.userId,
    canModerate:
      args.isOrgAdmin &&
      args.row.ownerUserId !== args.userId &&
      args.row.visibility === "public",
    createdAt: args.row.createdAt.toISOString(),
    updatedAt: args.row.updatedAt.toISOString(),
  };
}

export async function loadAccessibleImageReference(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly referenceId: string;
  },
): Promise<ImageReferenceRow | null> {
  const [row] = await db
    .select({
      ...imageReferenceColumns,
      sourceFilename: runUploadedFiles.filename,
      sourceContentType: runUploadedFiles.contentType,
      sourceStorageKey: runUploadedFiles.storageKey,
      creatorDisplayName: userCache.name,
      creatorImageUrl: userCache.imageUrl,
    })
    .from(imageReferences)
    .innerJoin(
      runUploadedFiles,
      eq(runUploadedFiles.id, imageReferences.sourceFileId),
    )
    .leftJoin(userCache, eq(userCache.userId, imageReferences.ownerUserId))
    .where(
      and(
        eq(imageReferences.id, args.referenceId),
        eq(imageReferences.orgId, args.orgId),
        or(
          eq(imageReferences.ownerUserId, args.userId),
          eq(imageReferences.visibility, "public"),
        ),
      ),
    )
    .limit(1);
  return row ? validateSelectedRow(row) : null;
}

export async function listAccessibleImageReferences(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly userId: string },
): Promise<readonly ImageReferenceRow[]> {
  const rows = await db
    .select({
      ...imageReferenceColumns,
      sourceFilename: runUploadedFiles.filename,
      sourceContentType: runUploadedFiles.contentType,
      sourceStorageKey: runUploadedFiles.storageKey,
      creatorDisplayName: userCache.name,
      creatorImageUrl: userCache.imageUrl,
    })
    .from(imageReferences)
    .innerJoin(
      runUploadedFiles,
      eq(runUploadedFiles.id, imageReferences.sourceFileId),
    )
    .leftJoin(userCache, eq(userCache.userId, imageReferences.ownerUserId))
    .where(
      and(
        eq(imageReferences.orgId, args.orgId),
        or(
          eq(imageReferences.ownerUserId, args.userId),
          eq(imageReferences.visibility, "public"),
        ),
      ),
    )
    .orderBy(
      desc(eq(imageReferences.ownerUserId, args.userId)),
      desc(imageReferences.createdAt),
      desc(imageReferences.id),
    );
  return rows.map(validateSelectedRow);
}

export async function loadAccessibleImageReferencesById(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly referenceIds: readonly string[];
  },
): Promise<readonly ImageReferenceRow[]> {
  if (args.referenceIds.length === 0) {
    return [];
  }
  const rows = await db
    .select({
      ...imageReferenceColumns,
      sourceFilename: runUploadedFiles.filename,
      sourceContentType: runUploadedFiles.contentType,
      sourceStorageKey: runUploadedFiles.storageKey,
      creatorDisplayName: userCache.name,
      creatorImageUrl: userCache.imageUrl,
    })
    .from(imageReferences)
    .innerJoin(
      runUploadedFiles,
      eq(runUploadedFiles.id, imageReferences.sourceFileId),
    )
    .leftJoin(userCache, eq(userCache.userId, imageReferences.ownerUserId))
    .where(
      and(
        inArray(imageReferences.id, [...new Set(args.referenceIds)]),
        eq(imageReferences.orgId, args.orgId),
        or(
          eq(imageReferences.ownerUserId, args.userId),
          eq(imageReferences.visibility, "public"),
        ),
      ),
    );
  return rows.map(validateSelectedRow);
}
