import { and, eq } from "drizzle-orm";
import { VOLUME_ORG_USER_ID, SYSTEM_ORG_ID } from "@vm0/core";
import { initServices } from "../../lib/init-services";
import { storages } from "../../db/schema/storage";
import { storageVersionLineage } from "../../db/schema/storage-version-lineage";

/**
 * Find a storage volume by clerk org and name.
 * Volumes use the sentinel VOLUME_ORG_USER_ID for org-level sharing.
 * Returns the storage id and name, or undefined if not found.
 */
export async function findTestStorageByName(
  orgId: string,
  name: string,
): Promise<{ id: string; name: string; s3Prefix: string } | undefined> {
  initServices();
  const [result] = await globalThis.services.db
    .select({
      id: storages.id,
      name: storages.name,
      s3Prefix: storages.s3Prefix,
    })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, orgId),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, name),
        eq(storages.type, "volume"),
      ),
    )
    .limit(1);
  return result;
}

/**
 * Find a storage record by clerk org, name, and type.
 * Returns the storage userId and other details for verification.
 */
export async function findTestStorage(
  orgId: string,
  name: string,
  type: "volume" | "artifact",
): Promise<
  { id: string; name: string; userId: string; s3Prefix: string } | undefined
> {
  initServices();
  const [result] = await globalThis.services.db
    .select({
      id: storages.id,
      name: storages.name,
      userId: storages.userId,
      s3Prefix: storages.s3Prefix,
    })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, orgId),
        eq(storages.name, name),
        eq(storages.type, type),
      ),
    )
    .limit(1);
  return result;
}

/**
 * Find a single system storage by name.
 */
export async function findTestSystemStorageByName(name: string) {
  initServices();
  const [storage] = await globalThis.services.db
    .select()
    .from(storages)
    .where(and(eq(storages.orgId, SYSTEM_ORG_ID), eq(storages.name, name)))
    .limit(1);
  return storage ?? null;
}

/**
 * Query storage version lineage records for a given versionId.
 * Used to verify lineage tracking in commit webhook tests.
 */
export async function getStorageVersionLineage(versionId: string) {
  initServices();
  return globalThis.services.db
    .select()
    .from(storageVersionLineage)
    .where(eq(storageVersionLineage.versionId, versionId));
}
