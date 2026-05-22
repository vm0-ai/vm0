import { eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { initServices } from "../../lib/init-services";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { uniqueId } from "../test-helpers";

interface TestStorageFile {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
}

function hashFileContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function computeContentHashFromHashes(
  storageId: string,
  files: readonly TestStorageFile[],
): string {
  if (files.length === 0) {
    return createHash("sha256").update(`storage:${storageId}\n`).digest("hex");
  }

  const entries = files
    .map((file) => {
      return `${file.path}:${file.hash}`;
    })
    .sort();

  return createHash("sha256")
    .update(`storage:${storageId}\n${entries.join("\n")}`)
    .digest("hex");
}

/**
 * Insert the storage metadata that the prepare route would create, without
 * inserting a version. This is used by tests for the remaining web commit route
 * after `/api/storages/prepare` moved behind the API backend rewrite.
 *
 * @why-db-direct The web prepare route has been removed; commit tests still
 * need a prepared storage row before exercising the web commit handler.
 */
export async function prepareTestStorage(params: {
  readonly userId: string;
  readonly orgId: string;
  readonly name: string;
  readonly type: "volume" | "artifact";
  readonly files: readonly TestStorageFile[];
}): Promise<{ readonly storageId: string; readonly versionId: string }> {
  initServices();
  const storageUserId =
    params.type === "volume" ? VOLUME_ORG_USER_ID : params.userId;
  const [storage] = await globalThis.services.db
    .insert(storages)
    .values({
      userId: storageUserId,
      orgId: params.orgId,
      name: params.name,
      type: params.type,
      s3Prefix: `${params.orgId}/${params.type}/${params.name}`,
      size: 0,
      fileCount: 0,
    })
    .onConflictDoUpdate({
      target: [storages.orgId, storages.userId, storages.name, storages.type],
      set: { updatedAt: new Date() },
    })
    .returning();

  if (!storage) {
    throw new Error("Failed to create storage");
  }

  return {
    storageId: storage.id,
    versionId: computeContentHashFromHashes(
      storage.id,
      params.files.map((file) => {
        return { path: file.path, hash: file.hash, size: file.size };
      }),
    ),
  };
}

/**
 * Insert the storage version metadata that the commit route would create after
 * S3 upload verification. This is used by web tests that need committed
 * storage records after both `/api/storages/prepare` and `/api/storages/commit`
 * moved behind API backend rewrites.
 *
 * @why-db-direct The web prepare and commit routes have been removed; web
 * tests still need storage fixtures without depending on apps/api route
 * handlers.
 */
export async function commitPreparedTestStorage(params: {
  readonly storageId: string;
  readonly versionId: string;
  readonly files: readonly TestStorageFile[];
}): Promise<{ readonly size: number; readonly fileCount: number }> {
  initServices();
  const totalSize = params.files.reduce((sum, file) => {
    return sum + file.size;
  }, 0);
  const fileCount = params.files.length;

  await globalThis.services.db.transaction(async (tx) => {
    const [storage] = await tx
      .select()
      .from(storages)
      .where(eq(storages.id, params.storageId))
      .limit(1);

    if (!storage) {
      throw new Error(`Storage "${params.storageId}" not found`);
    }

    await tx
      .insert(storageVersions)
      .values({
        id: params.versionId,
        storageId: params.storageId,
        s3Key: `${storage.s3Prefix}/${params.versionId}`,
        size: totalSize,
        fileCount,
        createdBy: "user",
      })
      .onConflictDoNothing();

    await tx
      .update(storages)
      .set({
        headVersionId: params.versionId,
        size: totalSize,
        fileCount,
        updatedAt: new Date(),
      })
      .where(eq(storages.id, params.storageId));
  });

  return { size: totalSize, fileCount };
}

/**
 * Create a volume storage directly in the DB for a specific org.
 * Unlike createTestVolume() which uses the mock user's org via API,
 * this allows creating storages under any org (e.g., SYSTEM_ORG_ID).
 *
 * @why-db-direct Creates volume under arbitrary org (e.g. SYSTEM_ORG_ID);
 * the API always uses the mock user's org from Clerk auth context, so
 * there is no way to create a storage for a different org via API.
 *
 * @param orgId - The org to create the storage under
 * @param name - Storage name
 * @returns The created storage with versionId
 */
export async function createTestVolumeForOrg(
  orgId: string,
  name: string,
): Promise<{ storageId: string; versionId: string }> {
  initServices();
  const versionId = randomUUID().replace(/-/g, "").repeat(2).slice(0, 64);
  const s3Key = `${orgId}/${name}/${versionId}`;

  return globalThis.services.db.transaction(async (tx) => {
    const [storage] = await tx
      .insert(storages)
      .values({
        orgId,
        userId: VOLUME_ORG_USER_ID,
        name,
        type: "volume",
        s3Prefix: `${orgId}/${name}`,
      })
      .returning();

    const storageId = storage!.id;

    await tx.insert(storageVersions).values({
      id: versionId,
      storageId,
      s3Key,
      size: 100,
      fileCount: 1,
      createdBy: "test",
    });

    await tx
      .update(storages)
      .set({ headVersionId: versionId })
      .where(eq(storages.id, storageId));

    return { storageId, versionId };
  });
}

/**
 * Insert an extra storage version record with a controlled ID.
 * Used to create deterministic ambiguous-prefix test scenarios where
 * two versions share the same prefix but the content hash is different.
 *
 * @why-db-direct Inserts version with a controlled ID for ambiguous-prefix
 * testing; no API endpoint exists for inserting arbitrary version IDs.
 *
 * @param storageName - Name of an existing storage (must already have a version)
 * @param versionId - The 64-char hex version ID to insert
 */
export async function insertStorageVersion(
  storageName: string,
  versionId: string,
): Promise<void> {
  initServices();
  const [storage] = await globalThis.services.db
    .select()
    .from(storages)
    .where(eq(storages.name, storageName))
    .limit(1);

  if (!storage) {
    throw new Error(`Storage "${storageName}" not found`);
  }

  await globalThis.services.db
    .insert(storageVersions)
    .values({
      id: versionId,
      storageId: storage.id,
      s3Key: `test/${versionId}`,
      size: 0,
      fileCount: 0,
      createdBy: "test",
    })
    .onConflictDoUpdate({
      target: storageVersions.id,
      set: { storageId: storage.id },
    });
}

/**
 * Insert a test artifact storage with a version for export testing.
 *
 * @why-db-direct Inserts minimal artifact+version bypassing the prepare/commit
 * flow; export testing needs a minimal storage record without S3 upload
 * side effects.
 */
export async function insertTestArtifactStorage(
  userId: string,
  orgId: string,
  name: string,
) {
  initServices();
  const versionId = hashFileContent(Buffer.from(uniqueId("sv")));

  const [storage] = await globalThis.services.db
    .insert(storages)
    .values({
      userId,
      orgId,
      name,
      type: "artifact",
      s3Prefix: `${userId}/artifact/${name}`,
      size: 1024,
      fileCount: 3,
    })
    .returning();

  await globalThis.services.db.insert(storageVersions).values({
    id: versionId,
    storageId: storage!.id,
    s3Key: `${userId}/artifact/${name}/${versionId}`,
    size: 1024,
    fileCount: 3,
    createdBy: userId,
  });

  await globalThis.services.db
    .update(storages)
    .set({ headVersionId: versionId })
    .where(eq(storages.id, storage!.id));

  return { storageId: storage!.id, versionId };
}

/**
 * Insert a test storage record directly.
 *
 * @why-db-direct Inserts bare storage record without version; deletion and
 * cleanup tests need minimal records without the API prepare/commit side
 * effects.
 */
export async function insertTestStorage(params: {
  userId: string;
  orgId: string;
  name: string;
  type?: "volume" | "artifact";
}): Promise<{ id: string }> {
  initServices();
  const [row] = await globalThis.services.db
    .insert(storages)
    .values({
      userId: params.userId,
      name: params.name,
      type: params.type ?? "volume",
      orgId: params.orgId,
      s3Prefix: `storages/${params.orgId}/${params.name}/`,
    })
    .returning({ id: storages.id });
  return row!;
}

/**
 * Insert a test storage version record directly.
 *
 * @why-db-direct Inserts bare version record; deletion and cleanup tests need
 * version records without the full prepare/commit flow and S3 upload side
 * effects.
 */
export async function insertTestStorageVersion(params: {
  storageId: string;
  createdBy: string;
}): Promise<void> {
  initServices();
  await globalThis.services.db.insert(storageVersions).values({
    id: uniqueId("sv"),
    storageId: params.storageId,
    s3Key: "test-key",
    size: 100,
    fileCount: 1,
    createdBy: params.createdBy,
  });
}
