import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { VOLUME_ORG_USER_ID, SYSTEM_ORG_ID } from "@vm0/core";
import { initServices } from "../../lib/init-services";
import { storages, storageVersions } from "../../db/schema/storage";
import { storageVersionLineage } from "../../db/schema/storage-version-lineage";
import { hashFileContent } from "../../lib/infra/storage/content-hash";
import { POST as storagePrepareRoute } from "../../../app/api/storages/prepare/route";
import { POST as storageCommitRoute } from "../../../app/api/storages/commit/route";
import { createTestRequest } from "./core";
import { uniqueId } from "../test-helpers";

interface TestFile {
  path: string;
  hash: string;
  size: number;
}

interface CreateTestStorageOptions {
  /** Storage type: "artifact", "volume", or "memory" */
  type?: "artifact" | "volume" | "memory";
  /** Files to include in the storage */
  files?: TestFile[];
  /** Skip the commit step (creates storage in prepare-only state) */
  skipCommit?: boolean;
  /** Create an empty storage (no files) */
  empty?: boolean;
}

/**
 * Create a test storage (artifact or volume) via API route handlers.
 * Uses the prepare/commit flow that the CLI uses.
 *
 * Internal helper - use createTestArtifact for testing.
 *
 * @param name - Storage name
 * @param options - Optional configuration
 * @returns The created storage with versionId
 */
async function createTestStorage(
  name: string,
  options?: CreateTestStorageOptions,
): Promise<{
  versionId: string;
  name: string;
  size: number;
  fileCount: number;
}> {
  const storageType = options?.type ?? "artifact";
  const empty = options?.empty ?? false;

  // Default test files (single file for simplicity)
  const files: TestFile[] = empty
    ? []
    : (options?.files ?? [
        {
          path: "test.txt",
          hash: "a".repeat(64), // Valid SHA-256 format
          size: 100,
        },
      ]);

  // Step 1: Prepare upload
  const prepareRequest = createTestRequest(
    "http://localhost:3000/api/storages/prepare",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageName: name,
        storageType,
        files,
      }),
    },
  );

  const prepareResponse = await storagePrepareRoute(prepareRequest);
  if (!prepareResponse.ok) {
    const error = await prepareResponse.json();
    throw new Error(
      `Failed to prepare storage: ${error.error?.message || prepareResponse.status}`,
    );
  }

  const prepareData = await prepareResponse.json();
  const { versionId, existing } = prepareData;

  // If version already exists (deduplication), skip commit
  if (existing || options?.skipCommit) {
    return {
      versionId,
      name,
      size: files.reduce((sum, f) => {
        return sum + f.size;
      }, 0),
      fileCount: files.length,
    };
  }

  // Step 2: Commit (S3 upload is mocked, so we just commit directly)
  const commitRequest = createTestRequest(
    "http://localhost:3000/api/storages/commit",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storageName: name,
        storageType,
        versionId,
        files,
      }),
    },
  );

  const commitResponse = await storageCommitRoute(commitRequest);
  if (!commitResponse.ok) {
    const error = await commitResponse.json();
    throw new Error(
      `Failed to commit storage: ${error.error?.message || commitResponse.status}`,
    );
  }

  const commitData = await commitResponse.json();
  return {
    versionId: commitData.versionId,
    name: commitData.storageName,
    size: commitData.size,
    fileCount: commitData.fileCount,
  };
}

/**
 * Create a test artifact via API route handlers.
 * Convenience wrapper around createTestStorage with type="artifact".
 *
 * @param name - Artifact name
 * @param options - Optional configuration
 * @returns The created artifact with versionId
 */
export async function createTestArtifact(
  name: string,
  options?: Omit<CreateTestStorageOptions, "type">,
): Promise<{
  versionId: string;
  name: string;
  size: number;
  fileCount: number;
}> {
  return createTestStorage(name, { ...options, type: "artifact" });
}

/**
 * Create a test volume via API route handlers.
 * Convenience wrapper around createTestStorage with type="volume".
 *
 * @param name - Volume name
 * @param options - Optional configuration
 * @returns The created volume with versionId
 */
export async function createTestVolume(
  name: string,
  options?: Omit<CreateTestStorageOptions, "type">,
): Promise<{
  versionId: string;
  name: string;
  size: number;
  fileCount: number;
}> {
  return createTestStorage(name, { ...options, type: "volume" });
}

/**
 * Create a volume storage directly in the DB for a specific org.
 * Unlike createTestVolume() which uses the mock user's org via API,
 * this allows creating storages under any org (e.g., SYSTEM_ORG_ID).
 *
 * @param orgId - The org to create the storage under
 * @param name - Storage name
 * @returns The created storage with versionId
 */
export async function createTestVolumeForOrg(
  orgId: string,
  name: string,
): Promise<{ storageId: string; versionId: string }> {
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
 * Create a test memory storage via API route handlers.
 * Convenience wrapper around createTestStorage with type="memory".
 *
 * @param name - Memory storage name
 * @param options - Optional configuration
 * @returns The created memory storage with versionId
 */
export async function createTestMemory(
  name: string,
  options?: Omit<CreateTestStorageOptions, "type">,
): Promise<{
  versionId: string;
  name: string;
  size: number;
  fileCount: number;
}> {
  return createTestStorage(name, { ...options, type: "memory" });
}

/**
 * Insert an extra storage version record with a controlled ID.
 * Used to create deterministic ambiguous-prefix test scenarios where
 * two versions share the same prefix but the content hash is different.
 *
 * @param storageName - Name of an existing storage (must already have a version)
 * @param versionId - The 64-char hex version ID to insert
 */
export async function insertStorageVersion(
  storageName: string,
  versionId: string,
): Promise<void> {
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
 * Find a storage volume by clerk org and name.
 * Volumes use the sentinel VOLUME_ORG_USER_ID for org-level sharing.
 * Returns the storage id and name, or undefined if not found.
 */
export async function findTestStorageByName(
  orgId: string,
  name: string,
): Promise<{ id: string; name: string; s3Prefix: string } | undefined> {
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
  type: "volume" | "artifact" | "memory",
): Promise<
  { id: string; name: string; userId: string; s3Prefix: string } | undefined
> {
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

/**
 * Insert a test artifact storage with a version for export testing.
 *
 * Direct DB insert is required because storage creation normally goes
 * through the prepare/commit flow, but we need a minimal record.
 */
export async function insertTestArtifactStorage(
  userId: string,
  orgId: string,
  name: string,
) {
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
 */
export async function insertTestStorage(params: {
  userId: string;
  orgId: string;
  name: string;
  type?: string;
}): Promise<{ id: string }> {
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
 */
export async function insertTestStorageVersion(params: {
  storageId: string;
  createdBy: string;
}): Promise<void> {
  await globalThis.services.db.insert(storageVersions).values({
    id: uniqueId("sv"),
    storageId: params.storageId,
    s3Key: "test-key",
    size: 100,
    fileCount: 1,
    createdBy: params.createdBy,
  });
}
