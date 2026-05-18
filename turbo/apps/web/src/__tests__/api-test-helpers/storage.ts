import { getTestAuthContext } from "./core";
import {
  commitPreparedTestStorage,
  prepareTestStorage,
} from "../db-test-seeders/storage";

// ---------------------------------------------------------------------------
// Re-exports: DB-direct seeders.
//
// These functions live in db-test-seeders/storage.ts but are re-exported
// here for backward compatibility — existing test files import from
// api-test-helpers and should continue to work unchanged.
// ---------------------------------------------------------------------------

export {
  createTestVolumeForOrg,
  insertStorageVersion,
  insertTestArtifactStorage,
  insertTestStorage,
  insertTestStorageVersion,
} from "../db-test-seeders/storage";

// ---------------------------------------------------------------------------
// Re-exports: Assertion helpers.
// ---------------------------------------------------------------------------

export {
  findTestStorageByName,
  findTestStorage,
  findTestSystemStorageByName,
  getStorageVersionLineage,
} from "../db-test-assertions/storage";

// ---------------------------------------------------------------------------
// Storage flow helpers.
//
// The prepare and commit routes now live in apps/api, so these helpers seed the
// storage metadata directly when a committed version is needed by web tests.
// ---------------------------------------------------------------------------

interface TestFile {
  path: string;
  hash: string;
  size: number;
}

interface CreateTestStorageOptions {
  /** Storage type: "artifact" or "volume" */
  type?: "artifact" | "volume";
  /** Files to include in the storage */
  files?: TestFile[];
  /** Skip the commit step (creates storage in prepare-only state) */
  skipCommit?: boolean;
  /** Create an empty storage (no files) */
  empty?: boolean;
}

/**
 * Create a test storage (artifact or volume).
 * Seeds the prepare-side storage record directly, then inserts commit-side
 * metadata when the caller needs a committed version.
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

  const { userId, orgId } = await getTestAuthContext();
  const { storageId, versionId } = await prepareTestStorage({
    userId,
    orgId,
    name,
    type: storageType,
    files,
  });

  if (options?.skipCommit) {
    return {
      versionId,
      name,
      size: files.reduce((sum, f) => {
        return sum + f.size;
      }, 0),
      fileCount: files.length,
    };
  }

  const commitData = await commitPreparedTestStorage({
    storageId,
    versionId,
    files,
  });
  return {
    versionId,
    name,
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
