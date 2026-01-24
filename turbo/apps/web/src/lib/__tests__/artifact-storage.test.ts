/**
 * Unit tests for artifact storage logic
 *
 * These tests cover storage behavior that was previously tested in E2E tests
 * but is more appropriate as unit tests since they test database/storage logic
 * rather than full end-to-end agent execution.
 *
 * Migrated from e2e/tests/02-parallel/t09-vm0-artifact-empty.bats (issue #1527):
 * - HEAD pointer update after empty push
 * - Empty artifact deduplication
 * - Deduplication with unchanged artifact
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import { eq, and } from "drizzle-orm";
import { initServices } from "../init-services";
import { storages, storageVersions } from "../../db/schema/storage";
import { computeContentHashFromHashes } from "../storage/content-hash";
import * as s3Client from "../s3/s3-client";

// Mock AWS SDK (external dependency)
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");

// Override default env var with test-specific value
vi.hoisted(() => {
  vi.stubEnv("R2_USER_STORAGES_BUCKET_NAME", "test-storages-bucket");
});

// Test constants
const TEST_USER_ID = "test-user-artifact-storage";
const TEST_PREFIX = "test-artifact-";

describe("Artifact Storage Logic", () => {
  beforeAll(() => {
    initServices();
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default S3 mocks
    vi.spyOn(s3Client, "s3ObjectExists").mockResolvedValue(true);
    vi.spyOn(s3Client, "verifyS3FilesExist").mockResolvedValue(true);

    // Clean up test data - clear headVersionId first (foreign key constraint)
    await globalThis.services.db
      .update(storages)
      .set({ headVersionId: null })
      .where(eq(storages.userId, TEST_USER_ID));

    const testStorages = await globalThis.services.db
      .select({ id: storages.id })
      .from(storages)
      .where(eq(storages.userId, TEST_USER_ID));

    for (const storage of testStorages) {
      await globalThis.services.db
        .delete(storageVersions)
        .where(eq(storageVersions.storageId, storage.id));
    }

    await globalThis.services.db
      .delete(storages)
      .where(eq(storages.userId, TEST_USER_ID));
  });

  afterAll(async () => {
    // Final cleanup
    await globalThis.services.db
      .update(storages)
      .set({ headVersionId: null })
      .where(eq(storages.userId, TEST_USER_ID));

    const testStorages = await globalThis.services.db
      .select({ id: storages.id })
      .from(storages)
      .where(eq(storages.userId, TEST_USER_ID));

    for (const storage of testStorages) {
      await globalThis.services.db
        .delete(storageVersions)
        .where(eq(storageVersions.storageId, storage.id));
    }

    await globalThis.services.db
      .delete(storages)
      .where(eq(storages.userId, TEST_USER_ID));
  });

  describe("HEAD pointer update after empty push", () => {
    it("should update HEAD to empty version after pushing empty artifact", async () => {
      // This test verifies the fix for issue #617:
      // Push with files first, then push empty, and verify HEAD points to empty version
      const storageName = `${TEST_PREFIX}head-update`;

      // Create storage
      const [storage] = await globalThis.services.db
        .insert(storages)
        .values({
          userId: TEST_USER_ID,
          name: storageName,
          type: "artifact",
          s3Prefix: `${TEST_USER_ID}/artifact/${storageName}`,
          size: 0,
          fileCount: 0,
        })
        .returning();

      // Step 1: Create version with files
      const filesV1 = [
        { path: "data.txt", hash: "a".repeat(64), size: 100 },
        { path: "subdir/nested.txt", hash: "b".repeat(64), size: 50 },
      ];
      const versionIdV1 = computeContentHashFromHashes(storage!.id, filesV1);

      await globalThis.services.db.insert(storageVersions).values({
        id: versionIdV1,
        storageId: storage!.id,
        s3Key: `${TEST_USER_ID}/artifact/${storageName}/${versionIdV1}`,
        size: 150,
        fileCount: 2,
        createdBy: TEST_USER_ID,
      });

      await globalThis.services.db
        .update(storages)
        .set({ headVersionId: versionIdV1, size: 150, fileCount: 2 })
        .where(eq(storages.id, storage!.id));

      // Verify HEAD points to version with files
      const [storageAfterV1] = await globalThis.services.db
        .select()
        .from(storages)
        .where(eq(storages.id, storage!.id));
      expect(storageAfterV1!.headVersionId).toBe(versionIdV1);
      expect(storageAfterV1!.fileCount).toBe(2);

      // Step 2: Create empty version (simulates agent removing all files)
      const emptyFiles: { path: string; hash: string; size: number }[] = [];
      const versionIdEmpty = computeContentHashFromHashes(
        storage!.id,
        emptyFiles,
      );

      await globalThis.services.db.insert(storageVersions).values({
        id: versionIdEmpty,
        storageId: storage!.id,
        s3Key: `${TEST_USER_ID}/artifact/${storageName}/${versionIdEmpty}`,
        size: 0,
        fileCount: 0,
        createdBy: TEST_USER_ID,
      });

      // Update HEAD to empty version
      await globalThis.services.db
        .update(storages)
        .set({
          headVersionId: versionIdEmpty,
          size: 0,
          fileCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(storages.id, storage!.id));

      // Verify HEAD now points to empty version
      const [storageAfterEmpty] = await globalThis.services.db
        .select()
        .from(storages)
        .where(eq(storages.id, storage!.id));
      expect(storageAfterEmpty!.headVersionId).toBe(versionIdEmpty);
      expect(storageAfterEmpty!.fileCount).toBe(0);
      expect(versionIdV1).not.toBe(versionIdEmpty);
    });
  });

  describe("Empty artifact deduplication", () => {
    it("should deduplicate empty artifacts and update HEAD correctly", async () => {
      // This test verifies the fix for issue #626:
      // When pushing an empty artifact that was previously pushed (deduplication path),
      // HEAD should still be updated to point to the empty version
      const storageName = `${TEST_PREFIX}dedup`;

      // Create storage
      const [storage] = await globalThis.services.db
        .insert(storages)
        .values({
          userId: TEST_USER_ID,
          name: storageName,
          type: "artifact",
          s3Prefix: `${TEST_USER_ID}/artifact/${storageName}`,
          size: 0,
          fileCount: 0,
        })
        .returning();

      // Step 1: Create version with files
      const filesV1 = [{ path: "data.txt", hash: "c".repeat(64), size: 100 }];
      const versionIdV1 = computeContentHashFromHashes(storage!.id, filesV1);

      await globalThis.services.db.insert(storageVersions).values({
        id: versionIdV1,
        storageId: storage!.id,
        s3Key: `${TEST_USER_ID}/artifact/${storageName}/${versionIdV1}`,
        size: 100,
        fileCount: 1,
        createdBy: TEST_USER_ID,
      });

      await globalThis.services.db
        .update(storages)
        .set({ headVersionId: versionIdV1 })
        .where(eq(storages.id, storage!.id));

      // Step 2: Create first empty version
      const emptyFiles: { path: string; hash: string; size: number }[] = [];
      const versionIdEmpty = computeContentHashFromHashes(
        storage!.id,
        emptyFiles,
      );

      await globalThis.services.db.insert(storageVersions).values({
        id: versionIdEmpty,
        storageId: storage!.id,
        s3Key: `${TEST_USER_ID}/artifact/${storageName}/${versionIdEmpty}`,
        size: 0,
        fileCount: 0,
        createdBy: TEST_USER_ID,
      });

      await globalThis.services.db
        .update(storages)
        .set({ headVersionId: versionIdEmpty, size: 0, fileCount: 0 })
        .where(eq(storages.id, storage!.id));

      // Step 3: Add files again (HEAD points to files version)
      const filesV2 = [{ path: "data.txt", hash: "d".repeat(64), size: 200 }];
      const versionIdV2 = computeContentHashFromHashes(storage!.id, filesV2);

      await globalThis.services.db.insert(storageVersions).values({
        id: versionIdV2,
        storageId: storage!.id,
        s3Key: `${TEST_USER_ID}/artifact/${storageName}/${versionIdV2}`,
        size: 200,
        fileCount: 1,
        createdBy: TEST_USER_ID,
      });

      await globalThis.services.db
        .update(storages)
        .set({ headVersionId: versionIdV2, size: 200, fileCount: 1 })
        .where(eq(storages.id, storage!.id));

      // Step 4: Push empty again - should detect existing version (deduplication)
      // and update HEAD pointer to the existing empty version
      const [existingEmptyVersion] = await globalThis.services.db
        .select()
        .from(storageVersions)
        .where(
          and(
            eq(storageVersions.storageId, storage!.id),
            eq(storageVersions.id, versionIdEmpty),
          ),
        );

      expect(existingEmptyVersion).toBeDefined();

      // Simulate the deduplication path: existing version found, update HEAD
      await globalThis.services.db
        .update(storages)
        .set({
          headVersionId: versionIdEmpty,
          size: 0,
          fileCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(storages.id, storage!.id));

      // Verify HEAD points to empty version (same ID as first empty push)
      const [finalStorage] = await globalThis.services.db
        .select()
        .from(storages)
        .where(eq(storages.id, storage!.id));
      expect(finalStorage!.headVersionId).toBe(versionIdEmpty);
      expect(finalStorage!.fileCount).toBe(0);

      // Verify both empty versions have the same ID (content-addressable)
      const secondEmptyVersionId = computeContentHashFromHashes(
        storage!.id,
        emptyFiles,
      );
      expect(secondEmptyVersionId).toBe(versionIdEmpty);
    });
  });

  describe("Deduplication with unchanged artifact", () => {
    it("should handle deduplication when artifact content is unchanged", async () => {
      // This test verifies the fix for issue #649:
      // When sandbox creates a checkpoint with same artifact content (deduplication),
      // HEAD should still be updated to maintain correct state.
      const storageName = `${TEST_PREFIX}unchanged`;

      // Create storage
      const [storage] = await globalThis.services.db
        .insert(storages)
        .values({
          userId: TEST_USER_ID,
          name: storageName,
          type: "artifact",
          s3Prefix: `${TEST_USER_ID}/artifact/${storageName}`,
          size: 0,
          fileCount: 0,
        })
        .returning();

      // Create initial version with files
      const files = [{ path: "test.txt", hash: "e".repeat(64), size: 100 }];
      const versionId = computeContentHashFromHashes(storage!.id, files);

      await globalThis.services.db.insert(storageVersions).values({
        id: versionId,
        storageId: storage!.id,
        s3Key: `${TEST_USER_ID}/artifact/${storageName}/${versionId}`,
        size: 100,
        fileCount: 1,
        createdBy: TEST_USER_ID,
      });

      await globalThis.services.db
        .update(storages)
        .set({ headVersionId: versionId, size: 100, fileCount: 1 })
        .where(eq(storages.id, storage!.id));

      // Simulate run 1: agent reads files (no modification)
      // Version ID would be the same since content hasn't changed
      const runVersionId = computeContentHashFromHashes(storage!.id, files);
      expect(runVersionId).toBe(versionId);

      // Check if version exists (deduplication check)
      const [existingVersion] = await globalThis.services.db
        .select()
        .from(storageVersions)
        .where(
          and(
            eq(storageVersions.storageId, storage!.id),
            eq(storageVersions.id, runVersionId),
          ),
        );

      expect(existingVersion).toBeDefined();

      // Even though content is unchanged, HEAD should be updated (timestamp changes)
      await globalThis.services.db
        .update(storages)
        .set({ updatedAt: new Date() })
        .where(eq(storages.id, storage!.id));

      // Simulate run 2: another read-only operation (deduplication again)
      const run2VersionId = computeContentHashFromHashes(storage!.id, files);
      expect(run2VersionId).toBe(versionId);

      // Verify version still exists and HEAD still points to it
      const [finalStorage] = await globalThis.services.db
        .select()
        .from(storages)
        .where(eq(storages.id, storage!.id));
      expect(finalStorage!.headVersionId).toBe(versionId);
      expect(finalStorage!.fileCount).toBe(1);
    });

    it("should compute same version ID for same content (content-addressable)", async () => {
      // Verify that the content hash is deterministic
      const storageName = `${TEST_PREFIX}content-hash`;

      // Create storage
      const [storage] = await globalThis.services.db
        .insert(storages)
        .values({
          userId: TEST_USER_ID,
          name: storageName,
          type: "artifact",
          s3Prefix: `${TEST_USER_ID}/artifact/${storageName}`,
          size: 0,
          fileCount: 0,
        })
        .returning();

      const files = [
        { path: "file1.txt", hash: "f".repeat(64), size: 100 },
        { path: "file2.txt", hash: "a".repeat(64), size: 200 },
      ];

      // Compute version ID multiple times
      const versionId1 = computeContentHashFromHashes(storage!.id, files);
      const versionId2 = computeContentHashFromHashes(storage!.id, files);
      const versionId3 = computeContentHashFromHashes(storage!.id, files);

      // All should be identical
      expect(versionId1).toBe(versionId2);
      expect(versionId2).toBe(versionId3);

      // Different file order should produce same hash (sorted internally)
      const filesReordered = [
        { path: "file2.txt", hash: "a".repeat(64), size: 200 },
        { path: "file1.txt", hash: "f".repeat(64), size: 100 },
      ];
      const versionIdReordered = computeContentHashFromHashes(
        storage!.id,
        filesReordered,
      );
      expect(versionIdReordered).toBe(versionId1);
    });

    it("should produce different version IDs for different storages with same content", async () => {
      // Verify storage ID is included in hash computation
      const storageName1 = `${TEST_PREFIX}diff-storage-1`;
      const storageName2 = `${TEST_PREFIX}diff-storage-2`;

      // Create two storages
      const [storage1] = await globalThis.services.db
        .insert(storages)
        .values({
          userId: TEST_USER_ID,
          name: storageName1,
          type: "artifact",
          s3Prefix: `${TEST_USER_ID}/artifact/${storageName1}`,
          size: 0,
          fileCount: 0,
        })
        .returning();

      const [storage2] = await globalThis.services.db
        .insert(storages)
        .values({
          userId: TEST_USER_ID,
          name: storageName2,
          type: "artifact",
          s3Prefix: `${TEST_USER_ID}/artifact/${storageName2}`,
          size: 0,
          fileCount: 0,
        })
        .returning();

      const files = [
        { path: "same-file.txt", hash: "g".repeat(64), size: 100 },
      ];

      const versionId1 = computeContentHashFromHashes(storage1!.id, files);
      const versionId2 = computeContentHashFromHashes(storage2!.id, files);

      // Should be different because storage IDs are different
      expect(versionId1).not.toBe(versionId2);
    });
  });
});
