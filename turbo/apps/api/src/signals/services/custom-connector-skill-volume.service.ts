import { command } from "ccstate";
import {
  getCustomConnectorSkillName,
  getCustomConnectorSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import { synthesizeSkillMd } from "@vm0/core/zero-workflow-skill";
import { storages } from "@vm0/db/schema/storage";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { deleteS3Objects, listS3ObjectsUnderPrefix } from "../external/s3";
import { uploadVolumeServerSide$ } from "./storage-volume-upload.service";
import { SKILL_FILENAME } from "./zero-workflow-volume.service";

export const syncCustomConnectorSkillVolume$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly connectorId: string;
      readonly connectorSlug: string;
      readonly displayName: string;
      readonly skillMarkdown: string | null;
      readonly skillName?: string;
      readonly skillDescription?: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const storageName = getCustomConnectorSkillStorageName(args.connectorId);
    if (args.skillMarkdown !== null) {
      await set(
        uploadVolumeServerSide$,
        {
          orgId: args.orgId,
          storageName,
          files: [
            {
              path: SKILL_FILENAME,
              content: synthesizeSkillMd({
                name:
                  args.skillName ??
                  getCustomConnectorSkillName(
                    args.connectorSlug,
                    args.connectorId,
                  ),
                description: args.skillDescription ?? args.displayName,
                instruction: args.skillMarkdown,
              }),
            },
          ],
        },
        signal,
      );
      signal.throwIfAborted();
      return;
    }

    const writeDb = set(writeDb$);
    const [storage] = await writeDb
      .delete(storages)
      .where(
        and(
          eq(storages.orgId, args.orgId),
          eq(storages.userId, VOLUME_ORG_USER_ID),
          eq(storages.name, storageName),
        ),
      )
      .returning({ s3Prefix: storages.s3Prefix });
    signal.throwIfAborted();
    if (!storage) {
      return;
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const objects = await get(
      listS3ObjectsUnderPrefix(bucket, storage.s3Prefix),
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
  },
);
