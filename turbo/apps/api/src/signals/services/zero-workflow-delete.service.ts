import {
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import { storages } from "@vm0/db/schema/storage";
import { zeroWorkflows } from "@vm0/db/schema/zero-workflow";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { deleteS3Objects, listS3ObjectsUnderPrefix } from "../external/s3";

interface DeleteZeroWorkflowInput {
  readonly orgId: string;
  readonly workflowName: string;
}

export const deleteZeroWorkflow$ = command(
  async (
    { get, set },
    args: DeleteZeroWorkflowInput,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const writeDb = set(writeDb$);

    const result = await writeDb.transaction(async (tx) => {
      const [workflow] = await tx
        .select({ id: zeroWorkflows.id })
        .from(zeroWorkflows)
        .where(
          and(
            eq(zeroWorkflows.orgId, args.orgId),
            eq(zeroWorkflows.name, args.workflowName),
          ),
        )
        .limit(1);

      if (!workflow) {
        return { deleted: false as const };
      }

      await tx.delete(zeroWorkflows).where(eq(zeroWorkflows.id, workflow.id));

      const storageName = getCustomSkillStorageName(args.workflowName);
      const [storage] = await tx
        .select({ id: storages.id, s3Prefix: storages.s3Prefix })
        .from(storages)
        .where(
          and(
            eq(storages.orgId, args.orgId),
            eq(storages.userId, VOLUME_ORG_USER_ID),
            eq(storages.name, storageName),
            eq(storages.type, "volume"),
          ),
        )
        .limit(1);

      if (storage) {
        await tx.delete(storages).where(eq(storages.id, storage.id));
      }

      return {
        deleted: true as const,
        s3Prefix: storage?.s3Prefix ?? null,
      };
    });
    signal.throwIfAborted();

    if (!result.deleted) {
      return false;
    }

    if (result.s3Prefix) {
      const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
      const objects = await get(
        listS3ObjectsUnderPrefix(bucket, result.s3Prefix),
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
