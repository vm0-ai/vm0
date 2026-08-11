import {
  getPresentationTemplateStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import { presentationTemplates } from "@vm0/db/schema/presentation-template";
import { storages } from "@vm0/db/schema/storage";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { deleteS3Objects, listS3ObjectsUnderPrefix } from "../external/s3";

export const deletePresentationTemplate$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly ownerUserId: string;
      readonly templateId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const writeDb = set(writeDb$);
    const result = await writeDb.transaction(async (tx) => {
      const [template] = await tx
        .select({
          id: presentationTemplates.id,
          pageKeys: presentationTemplates.pageKeys,
        })
        .from(presentationTemplates)
        .where(
          and(
            eq(presentationTemplates.id, args.templateId),
            eq(presentationTemplates.orgId, args.orgId),
            eq(presentationTemplates.ownerUserId, args.ownerUserId),
          ),
        )
        .limit(1);
      if (!template) {
        return { deleted: false as const };
      }

      await tx
        .delete(presentationTemplates)
        .where(eq(presentationTemplates.id, template.id));

      const [storage] = await tx
        .select({ id: storages.id, s3Prefix: storages.s3Prefix })
        .from(storages)
        .where(
          and(
            eq(storages.orgId, args.orgId),
            eq(storages.userId, VOLUME_ORG_USER_ID),
            eq(storages.name, getPresentationTemplateStorageName(template.id)),
          ),
        )
        .limit(1);
      if (storage) {
        await tx.delete(storages).where(eq(storages.id, storage.id));
      }
      return {
        deleted: true as const,
        pageKeys: template.pageKeys,
        storagePrefix: storage?.s3Prefix ?? null,
      };
    });
    signal.throwIfAborted();
    if (!result.deleted) {
      return false;
    }

    if (result.pageKeys.length > 0) {
      await get(
        deleteS3Objects(env("R2_USER_ARTIFACTS_BUCKET_NAME"), result.pageKeys),
      );
      signal.throwIfAborted();
    }
    if (result.storagePrefix) {
      const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
      const objects = await get(
        listS3ObjectsUnderPrefix(bucket, result.storagePrefix),
      );
      signal.throwIfAborted();
      await get(
        deleteS3Objects(
          bucket,
          objects.map((object) => {
            return object.key;
          }),
        ),
      );
      signal.throwIfAborted();
    }
    return true;
  },
);
