import { randomUUID } from "node:crypto";

import { VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";

interface RegistryArchiveStorageSeed {
  readonly storageName: string;
  readonly versionId: string;
  readonly size: number;
  readonly fileCount: number;
}

/**
 * Seed a private registry-resource volume storage whose version carries a
 * pinned version id from the registry download allowlist.
 *
 * The allowlisted version ids are content hashes minted against production
 * storage rows. The product commit endpoint derives a version id from the
 * storage row's randomly generated UUID plus the uploaded file hashes, so no
 * sequence of product API calls can reproduce a pinned id — this state is
 * only constructible by inserting the rows directly.
 *
 * Version ids are a global primary key, so any row left behind by a previous
 * run (pointing at a different random org's s3 prefix) is dropped first to
 * keep the seeded s3 key deterministic for the caller.
 */
export async function seedRegistryArchiveStorage(
  seed: RegistryArchiveStorageSeed,
): Promise<{ readonly s3Key: string }> {
  const database = db();

  const [existing] = await database
    .select({ storageId: storageVersions.storageId })
    .from(storageVersions)
    .where(eq(storageVersions.id, seed.versionId))
    .limit(1);
  if (existing) {
    await database.delete(storages).where(eq(storages.id, existing.storageId));
  }

  const orgId = `org_${randomUUID()}`;
  const s3Prefix = `${orgId}/volume/${seed.storageName}`;
  const s3Key = `${s3Prefix}/${seed.versionId}`;

  const [storage] = await database
    .insert(storages)
    .values({
      userId: VOLUME_ORG_USER_ID,
      orgId,
      name: seed.storageName,
      type: "volume",
      s3Prefix,
      size: seed.size,
      fileCount: seed.fileCount,
    })
    .returning({ id: storages.id });
  if (!storage) {
    throw new Error(`Failed to seed registry storage ${seed.storageName}`);
  }

  await database.insert(storageVersions).values({
    id: seed.versionId,
    storageId: storage.id,
    s3Key,
    size: seed.size,
    fileCount: seed.fileCount,
    createdBy: VOLUME_ORG_USER_ID,
  });

  return { s3Key };
}
