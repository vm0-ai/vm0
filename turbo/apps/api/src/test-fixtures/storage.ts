/**
 * In-process test fixture for `storages` / `storage_versions` rows.
 *
 * Reading a storage's stored S3 identity is unreachable through product APIs
 * because list responses do not expose `s3_prefix` or version `s3_key`.
 */
import { storages } from "@okouai/db/schema/storage";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";

export async function readStorageIdentityFixture(values: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}): Promise<{ readonly id: string; readonly s3Prefix: string }> {
  const db = createStore().set(writeDb$);
  const [row] = await db
    .select({ id: storages.id, s3Prefix: storages.s3Prefix })
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
  return row;
}

export async function readStorageS3PrefixFixture(values: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}): Promise<string> {
  return (await readStorageIdentityFixture(values)).s3Prefix;
}
