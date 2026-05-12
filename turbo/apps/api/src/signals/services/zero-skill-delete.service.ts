import {
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import { storages } from "@vm0/db/schema/storage";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroSkills } from "@vm0/db/schema/zero-skill";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { deleteS3Objects, listS3Objects } from "../external/s3";
import { nowDate } from "../external/time";

interface DeleteZeroSkillInput {
  readonly orgId: string;
  readonly skillName: string;
}

export const deleteZeroSkill$ = command(
  async (
    { get, set },
    args: DeleteZeroSkillInput,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const writeDb = set(writeDb$);

    const result = await writeDb.transaction(async (tx) => {
      const [skill] = await tx
        .select({ id: zeroSkills.id })
        .from(zeroSkills)
        .where(
          and(
            eq(zeroSkills.orgId, args.orgId),
            eq(zeroSkills.name, args.skillName),
          ),
        )
        .limit(1);

      if (!skill) {
        return { deleted: false as const };
      }

      const affectedAgents = await tx
        .select({
          id: zeroAgents.id,
          customSkills: zeroAgents.customSkills,
        })
        .from(zeroAgents)
        .where(
          and(
            eq(zeroAgents.orgId, args.orgId),
            sql`${zeroAgents.customSkills} @> ${JSON.stringify([args.skillName])}::jsonb`,
          ),
        );

      const updatedAt = nowDate();
      for (const agent of affectedAgents) {
        await tx
          .update(zeroAgents)
          .set({
            customSkills: agent.customSkills.filter((skillName) => {
              return skillName !== args.skillName;
            }),
            updatedAt,
          })
          .where(eq(zeroAgents.id, agent.id));
      }

      await tx.delete(zeroSkills).where(eq(zeroSkills.id, skill.id));

      const storageName = getCustomSkillStorageName(args.skillName);
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
      const objects = await get(listS3Objects(bucket, result.s3Prefix));
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
