import { describe, it, expect, vi, beforeEach } from "vitest";
import { StorageService } from "../storage-service";
import type { AgentVolumeConfig, PreparedStorage } from "../types";
import * as storageResolver from "../storage-resolver";
import * as s3Client from "../../s3/s3-client";
import * as fs from "node:fs";

// Mock dependencies
vi.mock("../storage-resolver");
vi.mock("../../s3/s3-client");
vi.mock("../../../env", () => ({
  env: () => ({
    S3_USER_STORAGES_NAME: "vm0-s3-user-volumes",
  }),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    promises: {
      mkdir: vi.fn(),
      readdir: vi.fn(),
      readFile: vi.fn(),
      stat: vi.fn(),
      rm: vi.fn(),
    },
  };
});

describe("StorageService", () => {
  let storageService: StorageService;

  beforeEach(() => {
    storageService = new StorageService();
    vi.clearAllMocks();
  });

  describe("prepareStorages", () => {
    it("should return empty result when no agent config provided", async () => {
      const result = await storageService.prepareStorages(
        undefined,
        {},
        "test-run-id",
        "user-123",
      );

      expect(result).toEqual({
        preparedStorages: [],
        preparedArtifact: null,
        tempDir: null,
        errors: [],
      });
    });

    it("should return empty result when no volumes or artifact configured", async () => {
      const agentConfig: AgentVolumeConfig = {
        agents: [
          {
            volumes: [],
            working_dir: "/home/user/workspace",
          },
        ],
      };

      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [],
        artifact: null,
        errors: [],
      });

      const result = await storageService.prepareStorages(
        agentConfig,
        {},
        "test-run-id",
        "user-123",
        undefined,
        undefined,
        true, // skipArtifact
      );

      expect(result).toEqual({
        preparedStorages: [],
        preparedArtifact: null,
        tempDir: null,
        errors: [],
      });
    });

    it("should handle volume resolution errors", async () => {
      const agentConfig: AgentVolumeConfig = {
        agents: [
          {
            volumes: ["data:/workspace/data"],
            working_dir: "/home/user/workspace",
          },
        ],
      };

      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [],
        artifact: null,
        errors: [
          {
            volumeName: "data",
            message: "Volume not found",
            type: "missing_definition",
          },
        ],
      });

      const result = await storageService.prepareStorages(
        agentConfig,
        {},
        "test-run-id",
        "user-123",
        "my-artifact",
      );

      expect(result.preparedStorages).toHaveLength(0);
      expect(result.tempDir).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toBe("data: Volume not found");
    });

    it("should prepare VM0 artifact when artifact name is provided", async () => {
      const agentConfig: AgentVolumeConfig = {
        agents: [
          {
            working_dir: "/home/user/workspace",
          },
        ],
      };

      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [],
        artifact: {
          driver: "vm0",
          mountPath: "/home/user/workspace",
          vm0StorageName: "my-artifact",
          vm0Version: "latest",
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

      vi.mocked(s3Client.downloadS3Directory).mockResolvedValue({
        localPath: "/tmp/vm0-run-test-run-id/artifact",
        filesDownloaded: 5,
        totalBytes: 1024,
      });

      const result = await storageService.prepareStorages(
        agentConfig,
        {},
        "test-run-id",
        "user-123",
        "my-artifact",
        "latest",
      );

      expect(result.preparedArtifact).not.toBeNull();
      expect(result.preparedArtifact?.driver).toBe("vm0");
      expect(result.preparedArtifact?.vm0StorageName).toBe("my-artifact");
      expect(result.preparedArtifact?.vm0VersionId).toBe("version-123");
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("mountStorages", () => {
    it("should do nothing when no storages or artifact provided", async () => {
      const mockSandbox = {
        files: {
          write: vi.fn(),
        },
        commands: {
          run: vi.fn(),
        },
      };

      await storageService.mountStorages(mockSandbox as never, [], null);

      expect(mockSandbox.files.write).not.toHaveBeenCalled();
      expect(mockSandbox.commands.run).not.toHaveBeenCalled();
    });

    it("should upload VM0 storages to sandbox", async () => {
      const mockSandbox = {
        files: {
          write: vi.fn(),
        },
        commands: {
          run: vi.fn().mockResolvedValue({ exitCode: 0 }),
        },
      };

      const preparedStorages: PreparedStorage[] = [
        {
          name: "dataset",
          driver: "vm0",
          localPath: "/tmp/vm0-run-test/dataset",
          mountPath: "/workspace/data",
          vm0StorageName: "my-dataset",
          vm0VersionId: "version-123",
        },
      ];

      vi.mocked(fs.promises.stat).mockResolvedValue({
        isDirectory: () => true,
      } as never);

      vi.mocked(fs.promises.readdir).mockResolvedValue([
        {
          name: "file.txt",
          isDirectory: () => false,
        } as never,
      ]);

      vi.mocked(fs.promises.readFile).mockResolvedValue(
        Buffer.from("test content"),
      );

      await storageService.mountStorages(
        mockSandbox as never,
        preparedStorages,
        null,
      );

      expect(mockSandbox.files.write).toHaveBeenCalled();
    });

    it("should upload VM0 artifact to sandbox", async () => {
      const mockSandbox = {
        files: {
          write: vi.fn(),
        },
        commands: {
          run: vi.fn().mockResolvedValue({ exitCode: 0 }),
        },
      };

      vi.mocked(fs.promises.stat).mockResolvedValue({
        isDirectory: () => true,
      } as never);

      vi.mocked(fs.promises.readdir).mockResolvedValue([
        {
          name: "file.txt",
          isDirectory: () => false,
        } as never,
      ]);

      vi.mocked(fs.promises.readFile).mockResolvedValue(
        Buffer.from("test content"),
      );

      await storageService.mountStorages(mockSandbox as never, [], {
        driver: "vm0",
        localPath: "/tmp/vm0-run-test/artifact",
        mountPath: "/home/user/workspace",
        vm0StorageName: "my-artifact",
        vm0VersionId: "version-123",
      });

      expect(mockSandbox.files.write).toHaveBeenCalled();
    });
  });

  describe("prepareArtifactFromSnapshot", () => {
    it("should prepare VM0 artifact from snapshot with specific version", async () => {
      const snapshot = {
        driver: "vm0" as const,
        mountPath: "/workspace",
        vm0StorageName: "test-artifact",
        snapshot: {
          versionId: "version-123-456",
        },
      };

      // Mock database query for storageVersions
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([
          {
            id: "version-123-456",
            storageId: "storage-id",
            s3Key: "user-123/test-artifact/version-123-456",
          },
        ]),
      };

      globalThis.services = {
        db: mockDb as never,
      } as never;

      vi.mocked(s3Client.downloadS3Directory).mockResolvedValue({
        localPath: "/tmp/vm0-run-test-run-id/artifact",
        filesDownloaded: 10,
        totalBytes: 2048,
      });

      const result = await storageService.prepareArtifactFromSnapshot(
        snapshot,
        "test-run-id",
      );

      expect(result.preparedArtifact).not.toBeNull();
      expect(result.preparedArtifact?.driver).toBe("vm0");
      expect(result.preparedArtifact?.vm0VersionId).toBe("version-123-456");
      expect(result.tempDir).toBe("/tmp/vm0-run-test-run-id");
      expect(result.errors).toHaveLength(0);

      // Verify S3 download was called with correct versioned path
      expect(s3Client.downloadS3Directory).toHaveBeenCalledWith(
        "s3://vm0-s3-user-volumes/user-123/test-artifact/version-123-456",
        expect.any(String),
      );
    });

    it("should return error when VM0 snapshot is missing versionId", async () => {
      const snapshot = {
        driver: "vm0" as const,
        mountPath: "/workspace",
        vm0StorageName: "test-artifact",
        // No snapshot with versionId
      };

      const result = await storageService.prepareArtifactFromSnapshot(
        snapshot,
        "test-run-id",
      );

      expect(result.preparedArtifact).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("VM0 snapshot missing versionId");
    });
  });

  describe("cleanup", () => {
    it("should do nothing when tempDir is null", async () => {
      await storageService.cleanup(null);

      expect(fs.promises.rm).not.toHaveBeenCalled();
    });

    it("should remove temp directory", async () => {
      const tempDir = "/tmp/vm0-run-test";

      await storageService.cleanup(tempDir);

      expect(fs.promises.rm).toHaveBeenCalledWith(tempDir, {
        recursive: true,
        force: true,
      });
    });

    it("should handle cleanup errors gracefully", async () => {
      const tempDir = "/tmp/vm0-run-test";

      vi.mocked(fs.promises.rm).mockRejectedValue(
        new Error("Permission denied"),
      );

      // Should not throw
      await storageService.cleanup(tempDir);

      expect(fs.promises.rm).toHaveBeenCalled();
    });
  });
});
