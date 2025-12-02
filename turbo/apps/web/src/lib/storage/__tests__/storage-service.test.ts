import { describe, it, expect, vi, beforeEach } from "vitest";
import { StorageService } from "../storage-service";
import type { AgentVolumeConfig } from "../types";
import * as storageResolver from "../storage-resolver";
import * as s3Client from "../../s3/s3-client";

// Mock dependencies
vi.mock("../storage-resolver");
vi.mock("../../s3/s3-client");
vi.mock("../../../env", () => ({
  env: () => ({
    S3_USER_STORAGES_NAME: "vas-s3-user-volumes",
  }),
}));

describe("StorageService", () => {
  let storageService: StorageService;

  beforeEach(() => {
    storageService = new StorageService();
    vi.clearAllMocks();
  });

  describe("prepareStorageManifest", () => {
    it("should return empty manifest when no agent config and no resumeArtifact", async () => {
      const result = await storageService.prepareStorageManifest(
        undefined,
        {},
        "user-123",
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
        "user-123",
      );

      expect(result.storages).toHaveLength(0);
      expect(result.artifact).toBeNull();
    });

    it("should generate presigned URLs for volumes", async () => {
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
            vasStorageName: "my-dataset",
            vasVersion: "latest",
          },
        ],
        artifact: null,
        errors: [],
      });

      // Mock database queries for resolveVersion
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: "storage-123",
              name: "my-dataset",
              userId: "user-123",
              headVersionId: "version-abc",
            },
          ])
          .mockResolvedValueOnce([
            {
              id: "version-abc",
              storageId: "storage-123",
              s3Key: "user-123/my-dataset/version-abc",
            },
          ]),
      };

      globalThis.services = {
        db: mockDb as never,
      } as never;

      vi.mocked(s3Client.generatePresignedUrl).mockResolvedValue(
        "https://s3.example.com/archive.tar.gz",
      );
      vi.mocked(s3Client.listS3Objects).mockResolvedValue([
        { key: "archive.tar.gz", size: 3072, lastModified: new Date() },
      ]);

      const result = await storageService.prepareStorageManifest(
        agentConfig,
        {},
        "user-123",
      );

      expect(result.storages).toHaveLength(1);
      expect(result.storages[0]?.name).toBe("data");
      expect(result.storages[0]?.vasStorageName).toBe("my-dataset");
      expect(result.storages[0]?.vasVersionId).toBe("version-abc");
      expect(result.storages[0]?.archiveUrl).toBe(
        "https://s3.example.com/archive.tar.gz",
      );
      expect(result.storages[0]?.archiveSize).toBe(3072);
      expect(result.artifact).toBeNull();
    });

    it("should generate presigned URLs for artifact", async () => {
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
          vasStorageName: "my-artifact",
          vasVersion: "latest",
        },
        errors: [],
      });

      // Mock database queries
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: "storage-123",
              name: "my-artifact",
              userId: "user-123",
              headVersionId: "version-123",
            },
          ])
          .mockResolvedValueOnce([
            {
              id: "version-123",
              storageId: "storage-123",
              s3Key: "user-123/my-artifact/version-123",
            },
          ]),
      };

      globalThis.services = {
        db: mockDb as never,
      } as never;

      vi.mocked(s3Client.generatePresignedUrl).mockResolvedValue(
        "https://s3.example.com/artifact-archive.tar.gz",
      );
      vi.mocked(s3Client.listS3Objects).mockResolvedValue([
        { key: "archive.tar.gz", size: 512, lastModified: new Date() },
      ]);

      const result = await storageService.prepareStorageManifest(
        agentConfig,
        {},
        "user-123",
        "my-artifact",
        "latest",
      );

      expect(result.storages).toHaveLength(0);
      expect(result.artifact).not.toBeNull();
      expect(result.artifact?.vasStorageName).toBe("my-artifact");
      expect(result.artifact?.vasVersionId).toBe("version-123");
      expect(result.artifact?.archiveUrl).toBe(
        "https://s3.example.com/artifact-archive.tar.gz",
      );
      expect(result.artifact?.archiveSize).toBe(512);
    });

    it("should handle resumeArtifact for checkpoint resume", async () => {
      const agentConfig: AgentVolumeConfig = {
        agents: {
          "test-agent": {
            volumes: ["data:/workspace/data"],
            working_dir: "/home/user/workspace",
          },
        },
      };

      // When resumeArtifact is provided, resolveVolumes should skip artifact
      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [
          {
            name: "data",
            driver: "vas",
            mountPath: "/workspace/data",
            vasStorageName: "my-dataset",
            vasVersion: "latest",
          },
        ],
        artifact: null, // Skipped because we're using resumeArtifact
        errors: [],
      });

      // Mock database queries - volume first, then artifact
      let queryCount = 0;
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockImplementation(() => {
          queryCount++;
          if (queryCount === 1) {
            // Volume storage lookup
            return Promise.resolve([
              {
                id: "vol-storage-id",
                name: "my-dataset",
                userId: "user-123",
                headVersionId: "vol-version-head",
              },
            ]);
          } else if (queryCount === 2) {
            // Volume version lookup
            return Promise.resolve([
              {
                id: "vol-version-head",
                storageId: "vol-storage-id",
                s3Key: "user-123/my-dataset/vol-version-head",
              },
            ]);
          } else if (queryCount === 3) {
            // Artifact storage lookup
            return Promise.resolve([
              {
                id: "art-storage-id",
                name: "checkpoint-artifact",
                userId: "user-123",
                headVersionId: "art-version-head",
              },
            ]);
          } else {
            // Artifact version lookup
            return Promise.resolve([
              {
                id: "checkpoint-version-xyz",
                storageId: "art-storage-id",
                s3Key: "user-123/checkpoint-artifact/checkpoint-version-xyz",
              },
            ]);
          }
        }),
      };

      globalThis.services = {
        db: mockDb as never,
      } as never;

      vi.mocked(s3Client.generatePresignedUrl).mockResolvedValue(
        "https://s3.example.com/archive.tar.gz",
      );
      vi.mocked(s3Client.listS3Objects).mockResolvedValue([
        { key: "archive.tar.gz", size: 100, lastModified: new Date() },
      ]);

      const result = await storageService.prepareStorageManifest(
        agentConfig,
        {},
        "user-123",
        undefined, // No artifactName (using resumeArtifact instead)
        undefined, // No artifactVersion
        undefined, // No volumeVersionOverrides
        {
          artifactName: "checkpoint-artifact",
          artifactVersion: "checkpoint-version-xyz",
        },
        "/workspace", // resumeArtifactMountPath
      );

      expect(result.storages).toHaveLength(1);
      expect(result.artifact).not.toBeNull();
      expect(result.artifact?.vasStorageName).toBe("checkpoint-artifact");
      expect(result.artifact?.vasVersionId).toBe("checkpoint-version-xyz");
      expect(result.artifact?.mountPath).toBe("/workspace");
    });

    it("should throw error when resumeArtifactMountPath is not provided with resumeArtifact", async () => {
      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [],
        artifact: null,
        errors: [],
      });

      // No mount path provided - should throw BadRequestError
      await expect(
        storageService.prepareStorageManifest(
          undefined,
          {},
          "user-123",
          undefined,
          undefined,
          undefined,
          {
            artifactName: "my-artifact",
            artifactVersion: "version-id",
          },
          // Missing resumeArtifactMountPath - should throw error
        ),
      ).rejects.toThrow("resumeArtifactMountPath is required");
    });
  });
});
