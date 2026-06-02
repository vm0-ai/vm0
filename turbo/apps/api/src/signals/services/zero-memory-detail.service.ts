import { computed, type Computed } from "ccstate";
import { MEMORY_ARTIFACT_NAME } from "@vm0/core/storage-names";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { downloadS3Buffer, downloadManifest } from "../external/s3";
import { env } from "../../lib/env";
import { extractFilesFromTarGz } from "../../lib/tar";

interface MemoryDetailResult {
  readonly exists: boolean;
  readonly name: string;
  readonly size: number;
  readonly fileCount: number;
  readonly updatedAt: string | null;
  readonly files: readonly { readonly path: string; readonly size: number }[];
  readonly fileContents: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}

function emptyMemory(exists: boolean): MemoryDetailResult {
  return {
    exists,
    name: MEMORY_ARTIFACT_NAME,
    size: 0,
    fileCount: 0,
    updatedAt: null,
    files: [],
    fileContents: [],
  };
}

/**
 * Read-only detail for the current user's "memory" artifact (latest version),
 * including each text file's contents extracted from the S3 archive.
 *
 * Memory is a normal artifact (type='artifact') named "memory", scoped per
 * (orgId, userId). Returns `exists: false` when the user has never produced
 * memory; returns an empty file list when the artifact exists but is empty.
 */
export function zeroMemoryDetail(
  orgId: string,
  userId: string,
): Computed<Promise<MemoryDetailResult>> {
  return computed(async (get): Promise<MemoryDetailResult> => {
    const [storage] = await get(db$)
      .select({
        headVersionId: storages.headVersionId,
        size: storages.size,
        fileCount: storages.fileCount,
        updatedAt: storages.updatedAt,
      })
      .from(storages)
      .where(
        and(
          eq(storages.orgId, orgId),
          eq(storages.userId, userId),
          eq(storages.name, MEMORY_ARTIFACT_NAME),
          eq(storages.type, "artifact"),
        ),
      )
      .limit(1);

    if (!storage) {
      return emptyMemory(false);
    }

    const base: MemoryDetailResult = {
      exists: true,
      name: MEMORY_ARTIFACT_NAME,
      size: storage.size,
      fileCount: storage.fileCount,
      updatedAt: storage.updatedAt.toISOString(),
      files: [],
      fileContents: [],
    };

    if (!storage.headVersionId || storage.fileCount === 0) {
      return base;
    }

    const [version] = await get(db$)
      .select({ s3Key: storageVersions.s3Key })
      .from(storageVersions)
      .where(eq(storageVersions.id, storage.headVersionId))
      .limit(1);

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    if (!version || !bucket) {
      return base;
    }

    const manifest = await get(downloadManifest(bucket, version.s3Key));
    const normalize = (p: string): string => {
      return p.replace(/^\.\//, "");
    };
    const files = manifest.files.map((file) => {
      return { path: normalize(file.path), size: file.size };
    });

    const archiveKey = `${version.s3Key}/archive.tar.gz`;
    const archiveBuffer = await get(downloadS3Buffer(bucket, archiveKey));
    const fileContents = extractFilesFromTarGz(
      archiveBuffer,
      files.map((file) => {
        return file.path;
      }),
    );

    return { ...base, files, fileContents };
  });
}
