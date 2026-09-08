import { imageReferences } from "@okouai/db/schema/image-reference";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { and, eq } from "drizzle-orm";
import { command } from "ccstate";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { writeDb$ } from "../external/db";
import { deleteS3Objects } from "../external/s3";
import { tapError } from "../utils";

const L = logger("ImageReferenceDelete");

interface DeletedImageReference {
  readonly visibility: "private" | "public";
}

export const deleteImageReference$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly referenceId: string;
    },
    signal: AbortSignal,
  ): Promise<DeletedImageReference | null> => {
    const deleted = await set(writeDb$).transaction(async (tx) => {
      const [owned] = await tx
        .select({
          visibility: imageReferences.visibility,
          sourceFileId: imageReferences.sourceFileId,
          sourceUserId: runUploadedFiles.userId,
          sourceOrgId: runUploadedFiles.orgId,
          sourceAccessLevel: runUploadedFiles.accessLevel,
          sourceStatus: runUploadedFiles.materializationStatus,
          sourceStorageKey: runUploadedFiles.storageKey,
          sourceMetadata: runUploadedFiles.metadata,
        })
        .from(imageReferences)
        .innerJoin(
          runUploadedFiles,
          eq(runUploadedFiles.id, imageReferences.sourceFileId),
        )
        .where(
          and(
            eq(imageReferences.id, args.referenceId),
            eq(imageReferences.orgId, args.orgId),
            eq(imageReferences.ownerUserId, args.ownerUserId),
          ),
        )
        .for("update", { of: imageReferences })
        .limit(1);
      if (!owned) {
        return null;
      }

      const storage = owned.sourceMetadata.storage;
      const bucket = owned.sourceMetadata.bucket;
      if (
        owned.sourceUserId !== args.ownerUserId ||
        owned.sourceOrgId !== args.orgId ||
        owned.sourceAccessLevel !== "private" ||
        owned.sourceStatus !== "ready" ||
        storage !== "private-artifact-v1" ||
        typeof bucket !== "string" ||
        bucket !== env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME") ||
        !owned.sourceStorageKey
      ) {
        throw new Error(
          `Image reference ${args.referenceId} has invalid private source ownership`,
        );
      }

      const [referenceRow] = await tx
        .delete(imageReferences)
        .where(
          and(
            eq(imageReferences.id, args.referenceId),
            eq(imageReferences.orgId, args.orgId),
            eq(imageReferences.ownerUserId, args.ownerUserId),
          ),
        )
        .returning({ id: imageReferences.id });
      if (!referenceRow) {
        throw new Error(`Image reference disappeared: ${args.referenceId}`);
      }

      const [sourceRow] = await tx
        .delete(runUploadedFiles)
        .where(
          and(
            eq(runUploadedFiles.id, owned.sourceFileId),
            eq(runUploadedFiles.userId, args.ownerUserId),
            eq(runUploadedFiles.orgId, args.orgId),
          ),
        )
        .returning({ id: runUploadedFiles.id });
      if (!sourceRow) {
        throw new Error(
          `Image reference source disappeared: ${owned.sourceFileId}`,
        );
      }

      return {
        visibility: owned.visibility,
        bucket,
        storageKey: owned.sourceStorageKey,
      };
    });
    signal.throwIfAborted();
    if (!deleted) {
      return null;
    }

    await tapError(
      get(deleteS3Objects(deleted.bucket, [deleted.storageKey])),
      (error) => {
        L.warn("Failed to delete an image reference backing object", { error });
      },
    );
    signal.throwIfAborted();
    return { visibility: deleted.visibility };
  },
);
