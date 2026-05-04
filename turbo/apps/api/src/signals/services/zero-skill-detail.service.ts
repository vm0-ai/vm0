import { computed, type Computed } from "ccstate";
import {
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import { zeroSkills } from "@vm0/db/schema/zero-skill";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { downloadS3Buffer, downloadManifest } from "../external/s3";
import { env } from "../../lib/env";
import { extractFileFromTarGz } from "../../lib/tar";

const SKILL_FILENAME = "SKILL.md";

interface SkillDetailResult {
  readonly name: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly content: string | null;
  readonly files:
    | readonly { readonly path: string; readonly size: number }[]
    | null;
}

/**
 * Retrieve the full detail for a custom skill in the given org, including
 * SKILL.md content extracted from the S3 storage archive. Returns null
 * when the skill is not found.
 */
export function zeroSkillDetail(
  orgId: string,
  skillName: string,
): Computed<Promise<SkillDetailResult | null>> {
  return computed(async (get): Promise<SkillDetailResult | null> => {
    const [skill] = await get(db$)
      .select()
      .from(zeroSkills)
      .where(and(eq(zeroSkills.orgId, orgId), eq(zeroSkills.name, skillName)))
      .limit(1);

    if (!skill) {
      return null;
    }

    const storageName = getCustomSkillStorageName(skillName);
    const [storage] = await get(db$)
      .select({ headVersionId: storages.headVersionId })
      .from(storages)
      .where(
        and(
          eq(storages.orgId, orgId),
          eq(storages.userId, VOLUME_ORG_USER_ID),
          eq(storages.name, storageName),
        ),
      )
      .limit(1);

    if (!storage?.headVersionId) {
      return {
        name: skill.name,
        displayName: skill.displayName ?? null,
        description: skill.description ?? null,
        content: null,
        files: null,
      };
    }

    const [version] = await get(db$)
      .select({ s3Key: storageVersions.s3Key })
      .from(storageVersions)
      .where(eq(storageVersions.id, storage.headVersionId))
      .limit(1);

    if (!version) {
      return {
        name: skill.name,
        displayName: skill.displayName ?? null,
        description: skill.description ?? null,
        content: null,
        files: null,
      };
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    if (!bucket) {
      return {
        name: skill.name,
        displayName: skill.displayName ?? null,
        description: skill.description ?? null,
        content: null,
        files: null,
      };
    }

    const manifest = await get(downloadManifest(bucket, version.s3Key));
    const normalize = (p: string): string => {
      return p.replace(/^\.\//, "");
    };

    const filesList = manifest.files.map((f) => {
      return {
        path: normalize(f.path),
        size: f.size,
      };
    });

    const skillFile = manifest.files.find((f) => {
      return normalize(f.path) === SKILL_FILENAME;
    });

    if (!skillFile) {
      return {
        name: skill.name,
        displayName: skill.displayName ?? null,
        description: skill.description ?? null,
        content: null,
        files: filesList,
      };
    }

    const archiveKey = `${version.s3Key}/archive.tar.gz`;
    const archiveBuffer = await get(downloadS3Buffer(bucket, archiveKey));
    const content = extractFileFromTarGz(archiveBuffer, skillFile.path);

    return {
      name: skill.name,
      displayName: skill.displayName ?? null,
      description: skill.description ?? null,
      content,
      files: filesList,
    };
  });
}
