import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import { eq } from "drizzle-orm";
import type { AgentVolumeConfig } from "../types";
import * as storageResolver from "../storage-resolver";
import * as s3Client from "../../s3/s3-client";
import { initServices } from "../../init-services";
import { storages, storageVersions } from "../../../db/schema/storage";

// Mock external dependencies
vi.mock("../storage-resolver");
vi.mock("../../s3/s3-client");

// Set required environment variables before initServices
process.env.R2_USER_STORAGES_BUCKET_NAME = "test-storages-bucket";

// Test user ID for isolation
const TEST_USER_ID = "test-user-storage-service";
const TEST_PREFIX = "test-storage-";

// Import StorageService after setting up mocks
let StorageService: typeof import("../storage-service").StorageService;

describe("StorageService", () => {
  let storageService: InstanceType<typeof StorageService>;

  beforeAll(async () => {
    initServices();
    const storageModule = await import("../storage-service");
    StorageService = storageModule.StorageService;
  });

  beforeEach(async () => {
    storageService = new StorageService();
    vi.clearAllMocks();

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
    // Final cleanup - clear headVersionId first (foreign key constraint)
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

  describe("prepareStorageManifest", () => {
    it("should return empty manifest when no agent config and no resumeArtifact", async () => {
      const result = await storageService.prepareStorageManifest(
        undefined,
        {},
        TEST_USER_ID,
      );

      expect(result).toEqual({
        storages: [],
        artifact: null,
      });
    });

    it("should return empty manifest when agent config has no volumes or artifact", async () => {
      const agentConfig: AgentVolumeConfig = {
        agents: {
          "test-agent": {
            volumes: [],
            working_dir: "/home/user/workspace",
          },
        },
      };

      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [],
        artifact: null,
        errors: [],
      });

      const result = await storageService.prepareStorageManifest(
        agentConfig,
        {},
        TEST_USER_ID,
      );

      expect(result.storages).toHaveLength(0);
      expect(result.artifact).toBeNull();
    });

    it("should generate presigned URLs for volumes", async () => {
      // Create test storage and version in database
      const [storage] = await globalThis.services.db
        .insert(storages)
        .values({
          userId: TEST_USER_ID,
          name: `${TEST_PREFIX}dataset`,
          type: "volume",
          s3Prefix: `${TEST_USER_ID}/${TEST_PREFIX}dataset`,
          size: 3072,
          fileCount: 5,
        })
        .returning();

      const versionId = `${TEST_PREFIX}version-abc`;
      await globalThis.services.db.insert(storageVersions).values({
        id: versionId,
        storageId: storage!.id,
        s3Key: `${TEST_USER_ID}/${TEST_PREFIX}dataset/${versionId}`,
        size: 3072,
        fileCount: 5,
        createdBy: TEST_USER_ID,
      });

      // Update storage with head version
      await globalThis.services.db
        .update(storages)
        .set({ headVersionId: versionId })
        .where(eq(storages.id, storage!.id));

      const agentConfig: AgentVolumeConfig = {
        agents: {
          "test-agent": {
            volumes: ["data:/workspace/data"],
            working_dir: "/home/user/workspace",
          },
        },
      };

      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [
          {
            name: "data",
            driver: "vas",
            mountPath: "/workspace/data",
            vasStorageName: `${TEST_PREFIX}dataset`,
            vasVersion: "latest",
          },
        ],
        artifact: null,
        errors: [],
      });

      vi.mocked(s3Client.generatePresignedUrl).mockResolvedValue(
        "https://s3.example.com/archive.tar.gz",
      );
      vi.mocked(s3Client.listS3Objects).mockResolvedValue([
        { key: "archive.tar.gz", size: 3072, lastModified: new Date() },
      ]);

      const result = await storageService.prepareStorageManifest(
        agentConfig,
        {},
        TEST_USER_ID,
      );

      expect(result.storages).toHaveLength(1);
      expect(result.storages[0]?.name).toBe("data");
      expect(result.storages[0]?.vasStorageName).toBe(`${TEST_PREFIX}dataset`);
      expect(result.storages[0]?.vasVersionId).toBe(versionId);
      expect(result.storages[0]?.archiveUrl).toBe(
        "https://s3.example.com/archive.tar.gz",
      );
      expect(result.storages[0]?.archiveSize).toBe(3072);
      expect(result.artifact).toBeNull();
    });

    it("should generate presigned URLs for artifact", async () => {
      // Create test storage and version for artifact
      const [storage] = await globalThis.services.db
        .insert(storages)
        .values({
          userId: TEST_USER_ID,
          name: `${TEST_PREFIX}artifact`,
          type: "artifact",
          s3Prefix: `${TEST_USER_ID}/${TEST_PREFIX}artifact`,
          size: 512,
          fileCount: 2,
        })
        .returning();

      const versionId = `${TEST_PREFIX}version-123`;
      await globalThis.services.db.insert(storageVersions).values({
        id: versionId,
        storageId: storage!.id,
        s3Key: `${TEST_USER_ID}/${TEST_PREFIX}artifact/${versionId}`,
        size: 512,
        fileCount: 2,
        createdBy: TEST_USER_ID,
      });

      // Update storage with head version
      await globalThis.services.db
        .update(storages)
        .set({ headVersionId: versionId })
        .where(eq(storages.id, storage!.id));

      const agentConfig: AgentVolumeConfig = {
        agents: {
          "test-agent": {
            working_dir: "/home/user/workspace",
          },
        },
      };

      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [],
        artifact: {
          driver: "vas",
          mountPath: "/home/user/workspace",
          vasStorageName: `${TEST_PREFIX}artifact`,
          vasVersion: "latest",
        },
        errors: [],
      });

      vi.mocked(s3Client.generatePresignedUrl).mockResolvedValue(
        "https://s3.example.com/artifact-archive.tar.gz",
      );
      vi.mocked(s3Client.listS3Objects).mockResolvedValue([
        { key: "archive.tar.gz", size: 512, lastModified: new Date() },
      ]);

      const result = await storageService.prepareStorageManifest(
        agentConfig,
        {},
        TEST_USER_ID,
        `${TEST_PREFIX}artifact`,
        "latest",
      );

      expect(result.storages).toHaveLength(0);
      expect(result.artifact).not.toBeNull();
      expect(result.artifact?.vasStorageName).toBe(`${TEST_PREFIX}artifact`);
      expect(result.artifact?.vasVersionId).toBe(versionId);
      expect(result.artifact?.archiveUrl).toBe(
        "https://s3.example.com/artifact-archive.tar.gz",
      );
      expect(result.artifact?.archiveSize).toBe(512);
    });

    it("should handle resumeArtifact for checkpoint resume", async () => {
      // Create volume storage
      const [volumeStorage] = await globalThis.services.db
        .insert(storages)
        .values({
          userId: TEST_USER_ID,
          name: `${TEST_PREFIX}dataset-resume`,
          type: "volume",
          s3Prefix: `${TEST_USER_ID}/${TEST_PREFIX}dataset-resume`,
          size: 100,
          fileCount: 1,
        })
        .returning();

      const volumeVersionId = `${TEST_PREFIX}vol-version`;
      await globalThis.services.db.insert(storageVersions).values({
        id: volumeVersionId,
        storageId: volumeStorage!.id,
        s3Key: `${TEST_USER_ID}/${TEST_PREFIX}dataset-resume/${volumeVersionId}`,
        size: 100,
        fileCount: 1,
        createdBy: TEST_USER_ID,
      });

      await globalThis.services.db
        .update(storages)
        .set({ headVersionId: volumeVersionId })
        .where(eq(storages.id, volumeStorage!.id));

      // Create checkpoint artifact storage
      const [artifactStorage] = await globalThis.services.db
        .insert(storages)
        .values({
          userId: TEST_USER_ID,
          name: `${TEST_PREFIX}checkpoint`,
          type: "artifact",
          s3Prefix: `${TEST_USER_ID}/${TEST_PREFIX}checkpoint`,
          size: 200,
          fileCount: 3,
        })
        .returning();

      const checkpointVersionId = `${TEST_PREFIX}checkpoint-xyz`;
      await globalThis.services.db.insert(storageVersions).values({
        id: checkpointVersionId,
        storageId: artifactStorage!.id,
        s3Key: `${TEST_USER_ID}/${TEST_PREFIX}checkpoint/${checkpointVersionId}`,
        size: 200,
        fileCount: 3,
        createdBy: TEST_USER_ID,
      });

      await globalThis.services.db
        .update(storages)
        .set({ headVersionId: checkpointVersionId })
        .where(eq(storages.id, artifactStorage!.id));

      const agentConfig: AgentVolumeConfig = {
        agents: {
          "test-agent": {
            volumes: ["data:/workspace/data"],
            working_dir: "/home/user/workspace",
          },
        },
      };

      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [
          {
            name: "data",
            driver: "vas",
            mountPath: "/workspace/data",
            vasStorageName: `${TEST_PREFIX}dataset-resume`,
            vasVersion: "latest",
          },
        ],
        artifact: null,
        errors: [],
      });

      vi.mocked(s3Client.generatePresignedUrl).mockResolvedValue(
        "https://s3.example.com/archive.tar.gz",
      );
      vi.mocked(s3Client.listS3Objects).mockResolvedValue([
        { key: "archive.tar.gz", size: 100, lastModified: new Date() },
      ]);

      const result = await storageService.prepareStorageManifest(
        agentConfig,
        {},
        TEST_USER_ID,
        undefined,
        undefined,
        undefined,
        {
          artifactName: `${TEST_PREFIX}checkpoint`,
          artifactVersion: checkpointVersionId,
        },
        "/workspace",
      );

      expect(result.storages).toHaveLength(1);
      expect(result.artifact).not.toBeNull();
      expect(result.artifact?.vasStorageName).toBe(`${TEST_PREFIX}checkpoint`);
      expect(result.artifact?.vasVersionId).toBe(checkpointVersionId);
      expect(result.artifact?.mountPath).toBe("/workspace");
    });

    it("should throw error when resumeArtifactMountPath is not provided with resumeArtifact", async () => {
      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [],
        artifact: null,
        errors: [],
      });

      await expect(
        storageService.prepareStorageManifest(
          undefined,
          {},
          TEST_USER_ID,
          undefined,
          undefined,
          undefined,
          {
            artifactName: "my-artifact",
            artifactVersion: "version-id",
          },
        ),
      ).rejects.toThrow("resumeArtifactMountPath is required");
    });
  });
});
