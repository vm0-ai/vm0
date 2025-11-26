import { describe, it, expect, vi, beforeEach } from "vitest";
import { VolumeService } from "../volume-service";
import type { AgentVolumeConfig, PreparedVolume } from "../types";
import * as volumeResolver from "../volume-resolver";
import * as s3Client from "../../s3/s3-client";
import * as fs from "node:fs";

// Mock dependencies
vi.mock("../volume-resolver");
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

describe("VolumeService", () => {
  let volumeService: VolumeService;

  beforeEach(() => {
    volumeService = new VolumeService();
    vi.clearAllMocks();
  });

  describe("prepareVolumes", () => {
    it("should return empty result when no agent config provided", async () => {
      const result = await volumeService.prepareVolumes(
        undefined,
        {},
        "test-run-id",
      );

      expect(result).toEqual({
        preparedVolumes: [],
        preparedArtifact: null,
        tempDir: null,
        errors: [],
      });
    });

    it("should return empty result when no volumes configured", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          volumes: [],
        },
      };

      vi.mocked(volumeResolver.resolveVolumes).mockReturnValue({
        volumes: [],
        artifact: null,
        errors: [],
      });

      const result = await volumeService.prepareVolumes(
        agentConfig,
        {},
        "test-run-id",
      );

      expect(result).toEqual({
        preparedVolumes: [],
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

      vi.mocked(volumeResolver.resolveVolumes).mockReturnValue({
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

      const result = await volumeService.prepareVolumes(
        agentConfig,
        {},
        "test-run-id",
      );

      expect(result.preparedVolumes).toHaveLength(0);
      expect(result.tempDir).toBe(null);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toBe("data: Volume not found");
    });

    it("should return error when VM0 volume has no HEAD version", async () => {
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

      vi.mocked(volumeResolver.resolveVolumes).mockReturnValue({
        volumes: [
          {
            name: "claude-system",
            driver: "vm0",
            vm0VolumeName: "claude-files",
            mountPath: "/home/user/.config/claude",
          },
        ],
        artifact: null,
        errors: [],
      });

      // Mock globalThis.services.db to return a volume without HEAD version
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([
          {
            id: "vol-123",
            name: "claude-files",
            userId: "user-123",
            headVersionId: null, // No HEAD version
          },
        ]),
      };

      globalThis.services = {
        db: mockDb,
      } as never;

      const result = await volumeService.prepareVolumes(
        agentConfig,
        {},
        "test-run-id",
        "user-123",
      );

      expect(result.preparedVolumes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("claude-files");
      expect(result.errors[0]).toContain("has no HEAD version");
    });

    it("should return error when VM0 volume not found in database", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          volumes: ["claude-system:/home/user/.config/claude"],
        },
        volumes: {
          "claude-system": {
            driver: "vm0",
            driver_opts: {
              uri: "vm0://nonexistent-volume",
            },
          },
        },
      };

      vi.mocked(volumeResolver.resolveVolumes).mockReturnValue({
        volumes: [
          {
            name: "claude-system",
            driver: "vm0",
            vm0VolumeName: "nonexistent-volume",
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
        db: mockDb,
      } as never;

      const result = await volumeService.prepareVolumes(
        agentConfig,
        {},
        "test-run-id",
        "user-123",
      );

      expect(result.preparedVolumes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("nonexistent-volume");
      expect(result.errors[0]).toContain("not found in database");
    });
  });

  describe("prepareVolumes with artifact", () => {
    it("should prepare Git artifact successfully", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/workspace",
            driver: "git",
            driver_opts: {
              uri: "https://github.com/user/repo.git",
              branch: "main",
            },
          },
        },
      };

      vi.mocked(volumeResolver.resolveVolumes).mockReturnValue({
        volumes: [],
        artifact: {
          driver: "git",
          mountPath: "/workspace",
          gitUri: "https://github.com/user/repo.git",
          gitBranch: "main",
        },
        errors: [],
      });

      const result = await volumeService.prepareVolumes(
        agentConfig,
        {},
        "test-run-id",
      );

      expect(result.preparedArtifact).not.toBeNull();
      expect(result.preparedArtifact).toMatchObject({
        driver: "git",
        mountPath: "/workspace",
        gitUri: "https://github.com/user/repo.git",
        gitBranch: "main",
      });
      expect(result.errors).toHaveLength(0);
    });

    it("should prepare VM0 artifact successfully", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/workspace",
            driver: "vm0",
          },
        },
      };

      vi.mocked(volumeResolver.resolveVolumes).mockReturnValue({
        volumes: [],
        artifact: {
          driver: "vm0",
          mountPath: "/workspace",
          vm0VolumeName: "my-artifact",
        },
        errors: [],
      });

      // Mock database for VM0 artifact with two calls (volume lookup + version lookup)
      const mockDbVolumeResult = {
        id: "vol-123",
        name: "my-artifact",
        userId: "user-123",
        headVersionId: "version-456",
      };

      const mockDbVersionResult = {
        id: "version-456",
        volumeId: "vol-123",
        s3Key: "user-123/my-artifact/version-456",
      };

      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValueOnce([mockDbVolumeResult])
          .mockResolvedValueOnce([mockDbVersionResult]),
      };

      globalThis.services = {
        db: mockDb,
      } as never;

      vi.mocked(s3Client.downloadS3Directory).mockResolvedValue({
        localPath: "/tmp/vm0-run-test-run-id/artifact",
        filesDownloaded: 5,
        totalBytes: 1024,
      });

      const result = await volumeService.prepareVolumes(
        agentConfig,
        {},
        "test-run-id",
        "my-artifact",
        "user-123",
      );

      expect(result.preparedArtifact).not.toBeNull();
      expect(result.preparedArtifact?.driver).toBe("vm0");
      expect(result.preparedArtifact?.mountPath).toBe("/workspace");
    });

    it("should return null artifact when no artifact configured", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          volumes: [],
        },
      };

      vi.mocked(volumeResolver.resolveVolumes).mockReturnValue({
        volumes: [],
        artifact: null,
        errors: [],
      });

      const result = await volumeService.prepareVolumes(
        agentConfig,
        {},
        "test-run-id",
      );

      expect(result.preparedArtifact).toBeNull();
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("mountVolumes", () => {
    it("should do nothing when no volumes provided", async () => {
      const mockSandbox = {
        files: {
          write: vi.fn(),
        },
      };

      await volumeService.mountVolumes(mockSandbox as never, []);

      expect(mockSandbox.files.write).not.toHaveBeenCalled();
    });

    it("should upload VM0 volumes to sandbox", async () => {
      const mockSandbox = {
        files: {
          write: vi.fn(),
        },
      };

      const preparedVolumes: PreparedVolume[] = [
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

      await volumeService.mountVolumes(mockSandbox as never, preparedVolumes);

      expect(mockSandbox.files.write).toHaveBeenCalled();
    });

    it("should mount artifact when provided", async () => {
      const mockSandbox = {
        files: {
          write: vi.fn(),
        },
      };

      const preparedArtifact = {
        driver: "vm0" as const,
        localPath: "/tmp/vm0-run-test/artifact",
        mountPath: "/workspace",
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

      await volumeService.mountVolumes(
        mockSandbox as never,
        [],
        preparedArtifact,
      );

      expect(mockSandbox.files.write).toHaveBeenCalled();
    });
  });

  describe("cleanup", () => {
    it("should do nothing when tempDir is null", async () => {
      await volumeService.cleanup(null);

      expect(fs.promises.rm).not.toHaveBeenCalled();
    });

    it("should remove temp directory", async () => {
      const tempDir = "/tmp/vm0-run-test";

      await volumeService.cleanup(tempDir);

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

      await volumeService.cleanup(tempDir);

      expect(fs.promises.rm).toHaveBeenCalled();
    });
  });

  describe("prepareArtifactFromSnapshot", () => {
    it("should prepare Git artifact from snapshot with correct branch", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/workspace",
            driver: "git",
            driver_opts: {
              uri: "https://github.com/{{user}}/repo.git",
              branch: "main",
              token: "${CI_GITHUB_TOKEN}",
            },
          },
        },
      };

      const snapshot = {
        driver: "git" as const,
        mountPath: "/workspace",
        snapshot: {
          branch: "run-test-run-123",
          commitId: "abc123def456",
        },
      };

      vi.mocked(volumeResolver.resolveVolumes).mockReturnValue({
        volumes: [],
        artifact: {
          driver: "git",
          mountPath: "/workspace",
          gitUri: "https://github.com/lancy/repo.git",
          gitBranch: "main",
          gitToken: "test-token",
        },
        errors: [],
      });

      const result = await volumeService.prepareArtifactFromSnapshot(
        snapshot,
        agentConfig,
        { user: "lancy" },
        "test-run-id",
      );

      expect(result.preparedArtifact).not.toBeNull();
      expect(result.preparedArtifact).toMatchObject({
        driver: "git",
        mountPath: "/workspace",
        gitUri: "https://github.com/lancy/repo.git",
        gitBranch: "run-test-run-123", // From snapshot, not config
        gitToken: "test-token",
      });
      expect(result.errors).toHaveLength(0);
    });

    it("should return error when Git snapshot is missing branch", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/workspace",
            driver: "git",
            driver_opts: {
              uri: "https://github.com/user/repo.git",
              branch: "main",
            },
          },
        },
      };

      const snapshot = {
        driver: "git" as const,
        mountPath: "/workspace",
        // No snapshot data
      };

      const result = await volumeService.prepareArtifactFromSnapshot(
        snapshot,
        agentConfig,
        {},
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
        vm0VolumeName: "test-artifact",
        snapshot: {
          versionId: "version-123-456",
        },
      };

      // Mock database query for volumeVersions
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([
          {
            id: "version-123-456",
            volumeId: "volume-id",
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

      const result = await volumeService.prepareArtifactFromSnapshot(
        snapshot,
        agentConfig,
        {},
        "test-run-id",
      );

      expect(result.preparedArtifact).not.toBeNull();
      expect(result.preparedArtifact).toMatchObject({
        driver: "vm0",
        mountPath: "/workspace",
        vm0VolumeName: "test-artifact",
        vm0VersionId: "version-123-456",
      });
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
        vm0VolumeName: "test-artifact",
        // No snapshot with versionId
      };

      const result = await volumeService.prepareArtifactFromSnapshot(
        snapshot,
        agentConfig,
        {},
        "test-run-id",
      );

      expect(result.preparedArtifact).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("VM0 snapshot missing versionId");
    });

    it("should return error when VM0 artifact version not found in database", async () => {
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
        vm0VolumeName: "test-artifact",
        snapshot: {
          versionId: "non-existent-version",
        },
      };

      // Mock database query returning empty result
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      };

      globalThis.services = {
        db: mockDb as never,
      } as never;

      const result = await volumeService.prepareArtifactFromSnapshot(
        snapshot,
        agentConfig,
        {},
        "test-run-id",
      );

      expect(result.preparedArtifact).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain(
        'VM0 artifact version "non-existent-version" not found',
      );
    });

    it("should return error when agent config missing artifact definition", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          volumes: [],
        },
      };

      const snapshot = {
        driver: "git" as const,
        mountPath: "/workspace",
        snapshot: {
          branch: "main",
          commitId: "abc123",
        },
      };

      const result = await volumeService.prepareArtifactFromSnapshot(
        snapshot,
        agentConfig,
        {},
        "test-run-id",
      );

      expect(result.preparedArtifact).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain(
        "Agent config missing artifact definition",
      );
    });
  });
});
