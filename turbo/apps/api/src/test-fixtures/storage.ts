/**
 * In-process test fixture for `storages` / `storage_versions` rows.
 *
 * Legacy prefix formats (`{orgId}/{type}/{name}`, `vm0/...`) cannot be
 * created through product APIs anymore — new rows always get the
 * `{orgId}/{storageId}` prefix — but production still holds them, including
 * prefixes shared by several users' rows in the same org (#22148). The
 * user-deletion cleanup must keep handling those rows, so tests seed them
 * here. Reading a storage's stored prefix is equally unreachable through
 * product APIs because list responses do not expose `s3_prefix`.
 */
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";

export async function seedStorageFixture(values: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly type: string;
  readonly s3Prefix: string;
}): Promise<{ readonly storageId: string }> {
  const db = createStore().set(writeDb$);
  const [row] = await db
    .insert(storages)
    .values(values)
    .returning({ storageId: storages.id });
  if (!row) {
    throw new Error("Failed to seed storage fixture");
  }
  return row;
}

export async function seedStorageVersionFixture(values: {
  readonly storageId: string;
  readonly versionId: string;
  readonly size?: number;
  readonly fileCount?: number;
}): Promise<{ readonly s3Key: string }> {
  const db = createStore().set(writeDb$);
  const [storage] = await db
    .select({ s3Prefix: storages.s3Prefix })
    .from(storages)
    .where(eq(storages.id, values.storageId))
    .limit(1);
  if (!storage) {
    throw new Error("Cannot seed a version for a missing storage");
  }
  const s3Key = `${storage.s3Prefix}/${values.versionId}`;
  await db.insert(storageVersions).values({
    id: values.versionId,
    storageId: values.storageId,
    s3Key,
    size: values.size ?? 1,
    archiveSize: values.size ?? 1,
    fileCount: values.fileCount ?? 1,
    createdBy: "user",
  });
  return { s3Key };
}

export async function readStorageS3PrefixFixture(values: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly type: string;
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
        eq(storages.type, values.type),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error(
      `No storage row for ${values.orgId}/${values.userId}/${values.name}/${values.type}`,
    );
  }
  return row.s3Prefix;
}
