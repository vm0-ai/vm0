import { describe, it, expect, vi, beforeEach } from "vitest";
import { StorageService } from "../storage-service";
import type { AgentVolumeConfig, PreparedStorage } from "../types";
import * as storageResolver from "../storage-resolver";
import * as s3Client from "../../s3/s3-client";
import * as fs from "node:fs";

// Mock dependencies
vi.mock("../storage-resolver");
vi.mock("../../s3/s3-client");
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

    it("should prepare Git artifact successfully", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/home/user/workspace",
            driver: "git",
            driver_opts: {
              uri: "https://github.com/user/repo.git",
              branch: "main",
            },
          },
        },
      };

      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [],
        artifact: {
          driver: "git",
          mountPath: "/home/user/workspace",
          gitUri: "https://github.com/user/repo.git",
          gitBranch: "main",
        },
        errors: [],
      });

      const result = await storageService.prepareStorages(
        agentConfig,
        {},
        "test-run-id",
      );

      expect(result.preparedArtifact).toEqual({
        driver: "git",
        mountPath: "/home/user/workspace",
        gitUri: "https://github.com/user/repo.git",
        gitBranch: "main",
        gitToken: undefined,
      });
      expect(result.tempDir).toBeNull();
      expect(result.errors).toHaveLength(0);
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

    it("should return error when VM0 storage has no HEAD version", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          volumes: ["claude-system:/home/user/.config/claude"],
        },
        volumes: {
          "claude-system": {
            driver: "vm0",
            driver_opts: {
              uri: "vm0://claude-files",
            },
          },
        },
      };

      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [
          {
            name: "claude-system",
            driver: "vm0",
            vm0StorageName: "claude-files",
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

    it("should return error when VM0 storage not found in database", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          volumes: ["claude-system:/home/user/.config/claude"],
        },
        volumes: {
          "claude-system": {
            driver: "vm0",
            driver_opts: {
              uri: "vm0://nonexistent-storage",
            },
          },
        },
      };

      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [
          {
            name: "claude-system",
            driver: "vm0",
            vm0StorageName: "nonexistent-storage",
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

    it("should clone Git artifact to sandbox", async () => {
      const mockSandbox = {
        files: {
          write: vi.fn(),
        },
        commands: {
          run: vi
            .fn()
            .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
        },
      };

      await storageService.mountStorages(mockSandbox as never, [], {
        driver: "git",
        mountPath: "/home/user/workspace",
        gitUri: "https://github.com/user/repo.git",
        gitBranch: "main",
      });

      // Should run git clone command
      expect(mockSandbox.commands.run).toHaveBeenCalled();
      const commandCall = mockSandbox.commands.run.mock.calls[0];
      expect(commandCall?.[0]).toContain("git clone");
    });
  });

  describe("prepareArtifactFromSnapshot", () => {
    it("should prepare Git artifact from snapshot with correct branch", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/home/user/workspace",
            driver: "git",
            driver_opts: {
              uri: "https://github.com/{{user}}/question.git",
              branch: "main",
              token: "test-token",
            },
          },
        },
      };

      const snapshot = {
        driver: "git" as const,
        mountPath: "/home/user/workspace",
        snapshot: {
          branch: "run-test-run-123",
          commitId: "abc123def456",
        },
      };

      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [],
        artifact: {
          driver: "git",
          mountPath: "/home/user/workspace",
          gitUri: "https://github.com/lancy/question.git",
          gitBranch: "main",
          gitToken: "test-token",
        },
        errors: [],
      });

      const result = await storageService.prepareArtifactFromSnapshot(
        snapshot,
        agentConfig,
        { user: "lancy" },
        "test-run-id",
      );

      expect(result.preparedArtifact).not.toBeNull();
      expect(result.preparedArtifact?.driver).toBe("git");
      expect(result.preparedArtifact?.gitBranch).toBe("run-test-run-123");
      expect(result.preparedArtifact?.gitToken).toBe("test-token");
      expect(result.errors).toHaveLength(0);
    });

    it("should return error when snapshot is missing snapshot data", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/home/user/workspace",
            driver: "git",
            driver_opts: {
              uri: "https://github.com/{{user}}/question.git",
              branch: "main",
            },
          },
        },
      };

      const snapshot = {
        driver: "git" as const,
        mountPath: "/home/user/workspace",
        // Missing snapshot.branch
      };

      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [],
        artifact: {
          driver: "git",
          mountPath: "/home/user/workspace",
          gitUri: "https://github.com/lancy/question.git",
          gitBranch: "main",
        },
        errors: [],
      });

      const result = await storageService.prepareArtifactFromSnapshot(
        snapshot,
        agentConfig,
        { user: "lancy" },
        "test-run-id",
      );

      expect(result.preparedArtifact).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Git snapshot missing branch");
    });

    it("should prepare VM0 artifact from snapshot with specific version", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/workspace",
            driver: "vm0",
          },
        },
      };

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

      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [],
        artifact: {
          driver: "vm0",
          mountPath: "/workspace",
          vm0StorageName: "test-artifact",
        },
        errors: [],
      });

      vi.mocked(s3Client.downloadS3Directory).mockResolvedValue({
        localPath: "/tmp/vm0-run-test-run-id/artifact",
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
      const agentConfig: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/workspace",
            driver: "vm0",
          },
        },
      };

      const snapshot = {
        driver: "vm0" as const,
        mountPath: "/workspace",
        vm0StorageName: "test-artifact",
        // No snapshot with versionId
      };

      vi.mocked(storageResolver.resolveVolumes).mockReturnValue({
        volumes: [],
        artifact: {
          driver: "vm0",
          mountPath: "/workspace",
          vm0StorageName: "test-artifact",
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
