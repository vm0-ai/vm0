import type { Computed } from "ccstate";
import {
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { downloadManifest, downloadS3Buffer } from "../external/s3";
import { settle } from "../utils";
import { env } from "../../lib/env";
import { extractFilesFromTarGz } from "../../lib/tar";

export const SKILL_FILENAME = "SKILL.md";

export interface WorkflowVolumeFile {
  readonly path: string;
  readonly content: string;
  readonly size: number;
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, "");
}

function isMissingS3ObjectError(error: unknown): boolean {
  const candidate = error as {
    readonly name?: string;
    readonly Code?: string;
    readonly code?: string;
    readonly $metadata?: { readonly httpStatusCode?: number };
  };
  const code = candidate.Code ?? candidate.code ?? candidate.name;
  return (
    code === "NoSuchKey" ||
    code === "NotFound" ||
    (candidate.name === "NotFound" &&
      candidate.$metadata?.httpStatusCode === 404)
  );
}

/**
 * Load every file (path + content + size) from a workflow's volume, keyed by
 * the workflow id. Returns an empty list when the volume does not exist yet.
 * The synthesized SKILL.md is included; callers filter it out as needed.
 */
export async function loadWorkflowVolumeFiles(
  get: <T>(computedValue: Computed<T>) => T,
  args: { readonly orgId: string; readonly workflowId: string },
): Promise<readonly WorkflowVolumeFile[]> {
  const storageName = getCustomSkillStorageName(args.workflowId);
  const [storage] = await get(db$)
    .select({ headVersionId: storages.headVersionId })
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

  if (!storage?.headVersionId) {
    return [];
  }

  const [version] = await get(db$)
    .select({ s3Key: storageVersions.s3Key })
    .from(storageVersions)
    .where(eq(storageVersions.id, storage.headVersionId))
    .limit(1);

  if (!version) {
    return [];
  }

  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  if (!bucket) {
    return [];
  }

  const manifestResult = await settle(
    get(downloadManifest(bucket, version.s3Key)),
  );
  if (!manifestResult.ok) {
    if (isMissingS3ObjectError(manifestResult.error)) {
      return [];
    }
    throw manifestResult.error;
  }

  const filesList = manifestResult.value.files.map((f) => {
    return { path: normalizePath(f.path), size: f.size };
  });

  const archiveKey = `${version.s3Key}/archive.tar.gz`;
  const archiveResult = await settle(get(downloadS3Buffer(bucket, archiveKey)));
  if (!archiveResult.ok) {
    if (isMissingS3ObjectError(archiveResult.error)) {
      return [];
    }
    throw archiveResult.error;
  }

  const contents = extractFilesFromTarGz(
    archiveResult.value,
    filesList.map((file) => file.path),
  );
  const sizeByPath = new Map(filesList.map((file) => [file.path, file.size]));

  return contents.map((file) => {
    const path = normalizePath(file.path);
    return {
      path,
      content: file.content,
      size: sizeByPath.get(path) ?? Buffer.byteLength(file.content, "utf8"),
    };
  });
}
