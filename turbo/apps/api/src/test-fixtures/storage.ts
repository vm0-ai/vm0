/**
 * In-process test fixture for `storages` / `storage_versions` rows.
 *
 * Reading a storage's stored S3 identity is unreachable through product APIs
 * because list responses do not expose `s3_prefix` or version `s3_key`.
 */
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { createStore } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";

export async function readStorageS3PrefixFixture(values: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}): Promise<string> {
  const db = createStore().set(writeDb$);
  const [row] = await db
    .select({ s3Prefix: storages.s3Prefix })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, values.orgId),
        eq(storages.userId, values.userId),
        eq(storages.name, values.name),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error(
      `No storage row for ${values.orgId}/${values.userId}/${values.name}`,
    );
  }
  return row.s3Prefix;
}

export async function readSystemStorageVersionNameByS3KeyFixture(values: {
  readonly s3Key: string;
  readonly storageNames: readonly string[];
}): Promise<string | undefined> {
  const db = createStore().set(writeDb$);
  const [row] = await db
    .select({ name: storages.name })
    .from(storageVersions)
    .innerJoin(storages, eq(storages.id, storageVersions.storageId))
    .where(
      and(
        eq(storages.orgId, SYSTEM_ORG_ID),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        inArray(storages.name, values.storageNames),
        eq(storageVersions.s3Key, values.s3Key),
      ),
    )
    .limit(1);
  return row?.name;
}
