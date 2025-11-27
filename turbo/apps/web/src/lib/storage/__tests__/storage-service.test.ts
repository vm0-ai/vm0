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
    S3_USER_STORAGES_NAME: "vas-s3-user-volumes",
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
        agent: {
          volumes: [],
        },
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
        agent: {
          volumes: ["data:/workspace/data"],
        },
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
      );

      expect(result.preparedStorages).toHaveLength(0);
      expect(result.tempDir).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toBe("data: Volume not found");
    });

    it("should return error when VAS storage has no HEAD version", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          volumes: ["claude-system:/home/user/.config/claude"],
        },
        volumes: {
          "claude-system": {
            driver: "vas",
            driver_opts: {
              uri: "vas://claude-files",
            },
          },
        },
      };

      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [
          {
            name: "claude-system",
            driver: "vas",
            vasStorageName: "claude-files",
            mountPath: "/home/user/.config/claude",
          },
        ],
        artifact: null,
        errors: [],
      });

      // Mock globalThis.services.db to return a storage without HEAD version
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([
          {
            id: "storage-123",
            name: "claude-files",
            userId: "user-123",
            headVersionId: null, // No HEAD version
          },
        ]),
      };

      globalThis.services = {
        db: mockDb,
      } as never;

      const result = await storageService.prepareStorages(
        agentConfig,
        {},
        "test-run-id",
        "user-123",
      );

      expect(result.preparedStorages).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("claude-files");
      expect(result.errors[0]).toContain("has no HEAD version");
    });

    it("should return error when VAS storage not found in database", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          volumes: ["claude-system:/home/user/.config/claude"],
        },
        volumes: {
          "claude-system": {
            driver: "vas",
            driver_opts: {
              uri: "vas://nonexistent-storage",
            },
          },
        },
      };

      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [
          {
            name: "claude-system",
            driver: "vas",
            vasStorageName: "nonexistent-storage",
            mountPath: "/home/user/.config/claude",
          },
        ],
        artifact: null,
        errors: [],
      });

      // Mock globalThis.services.db to return empty result
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      };

      globalThis.services = {
        db: mockDb as never,
      } as never;

      const result = await storageService.prepareStorages(
        agentConfig,
        {},
        "test-run-id",
        "user-123",
      );

      expect(result.preparedStorages).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("nonexistent-storage");
      expect(result.errors[0]).toContain("not found");
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

    it("should upload VAS storages to sandbox", async () => {
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
          driver: "vas",
          localPath: "/tmp/vas-run-test/dataset",
          mountPath: "/workspace/data",
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

    it("should upload VAS artifact to sandbox", async () => {
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
        driver: "vas",
        localPath: "/tmp/vas-run-test/artifact",
        mountPath: "/home/user/workspace",
        vasStorageName: "my-artifact",
        vasVersionId: "version-123",
      });

      expect(mockSandbox.files.write).toHaveBeenCalled();
    });
  });

  describe("prepareArtifactFromSnapshot", () => {
    it("should prepare VAS artifact from snapshot with specific version", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/workspace",
            driver: "vas",
          },
        },
      };

      const snapshot = {
        driver: "vas" as const,
        mountPath: "/workspace",
        vasStorageName: "test-artifact",
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

      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [],
        artifact: {
          driver: "vas",
          mountPath: "/workspace",
          vasStorageName: "test-artifact",
        },
        errors: [],
      });

      vi.mocked(s3Client.downloadS3Directory).mockResolvedValue({
        localPath: "/tmp/vas-run-test-run-id/artifact",
        filesDownloaded: 10,
        totalBytes: 2048,
      });

      const result = await storageService.prepareArtifactFromSnapshot(
        snapshot,
        agentConfig,
        {},
        "test-run-id",
      );

      expect(result.preparedArtifact).not.toBeNull();
      expect(result.preparedArtifact?.driver).toBe("vas");
      expect(result.preparedArtifact?.vasVersionId).toBe("version-123-456");
      expect(result.tempDir).toBe("/tmp/vas-run-test-run-id");
      expect(result.errors).toHaveLength(0);

      // Verify S3 download was called with correct versioned path
      expect(s3Client.downloadS3Directory).toHaveBeenCalledWith(
        "s3://vas-s3-user-volumes/user-123/test-artifact/version-123-456",
        expect.any(String),
      );
    });

    it("should return error when VAS snapshot is missing versionId", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/workspace",
            driver: "vas",
          },
        },
      };

      const snapshot = {
        driver: "vas" as const,
        mountPath: "/workspace",
        vasStorageName: "test-artifact",
        // No snapshot with versionId
      };

      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [],
        artifact: {
          driver: "vas",
          mountPath: "/workspace",
          vasStorageName: "test-artifact",
        },
        errors: [],
      });

      const result = await storageService.prepareArtifactFromSnapshot(
        snapshot,
        agentConfig,
        {},
        "test-run-id",
      );

      expect(result.preparedArtifact).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("VAS snapshot missing versionId");
    });
  });

  describe("cleanup", () => {
    it("should do nothing when tempDir is null", async () => {
      await storageService.cleanup(null);

      expect(fs.promises.rm).not.toHaveBeenCalled();
    });

    it("should remove temp directory", async () => {
      const tempDir = "/tmp/vas-run-test";

      await storageService.cleanup(tempDir);

      expect(fs.promises.rm).toHaveBeenCalledWith(tempDir, {
        recursive: true,
        force: true,
      });
    });

    it("should handle cleanup errors gracefully", async () => {
      const tempDir = "/tmp/vas-run-test";

      vi.mocked(fs.promises.rm).mockRejectedValue(
        new Error("Permission denied"),
      );

      // Should not throw
      await storageService.cleanup(tempDir);

      expect(fs.promises.rm).toHaveBeenCalled();
    });
  });
});
