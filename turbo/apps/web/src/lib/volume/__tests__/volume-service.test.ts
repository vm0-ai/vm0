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
        errors: [],
      });

      const result = await volumeService.prepareVolumes(
        agentConfig,
        {},
        "test-run-id",
      );

      expect(result).toEqual({
        preparedVolumes: [],
        tempDir: null,
        errors: [],
      });
    });

    it("should prepare git volumes successfully", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          volumes: ["repo:/workspace"],
        },
        volumes: {
          repo: {
            driver: "git",
            driver_opts: {
              uri: "https://github.com/user/repo.git",
              branch: "main",
            },
          },
        },
      };

      vi.mocked(volumeResolver.resolveVolumes).mockReturnValue({
        volumes: [
          {
            name: "repo",
            driver: "git",
            gitUri: "https://github.com/user/repo.git",
            gitBranch: "main",
            mountPath: "/workspace",
          },
        ],
        errors: [],
      });

      const result = await volumeService.prepareVolumes(
        agentConfig,
        {},
        "test-run-id",
      );

      expect(result.preparedVolumes).toHaveLength(1);
      expect(result.preparedVolumes[0]).toEqual({
        name: "repo",
        driver: "git",
        mountPath: "/workspace",
        gitUri: "https://github.com/user/repo.git",
        gitBranch: "main",
        gitToken: undefined,
      });
      expect(result.tempDir).toBe("/tmp/vm0-run-test-run-id");
      expect(result.errors).toHaveLength(0);
      expect(fs.promises.mkdir).toHaveBeenCalledWith(
        "/tmp/vm0-run-test-run-id",
        { recursive: true },
      );
    });

    it("should handle volume resolution errors", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          volumes: ["data:/workspace/data"],
        },
      };

      vi.mocked(volumeResolver.resolveVolumes).mockReturnValue({
        volumes: [],
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

  describe("prepareVolumesFromSnapshots", () => {
    it("should prepare Git volume from snapshot with correct branch", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          volumes: ["user-workspace:/home/user/workspace"],
        },
        dynamic_volumes: {
          "user-workspace": {
            driver: "git",
            driver_opts: {
              uri: "https://github.com/{{user}}/question.git",
              branch: "main",
              token: "${CI_GITHUB_TOKEN}",
            },
          },
        },
      };

      const snapshots = [
        {
          name: "user-workspace",
          driver: "git" as const,
          mountPath: "/home/user/workspace",
          snapshot: {
            branch: "run-test-run-123",
            commitId: "abc123def456",
          },
        },
      ];

      vi.mocked(volumeResolver.resolveVolumes).mockReturnValue({
        volumes: [
          {
            name: "user-workspace",
            driver: "git",
            gitUri: "https://github.com/lancy/question.git",
            gitBranch: "main",
            gitToken: "test-token",
            mountPath: "/home/user/workspace",
          },
        ],
        errors: [],
      });

      const result = await volumeService.prepareVolumesFromSnapshots(
        snapshots,
        agentConfig,
        { user: "lancy" },
      );

      expect(result.preparedVolumes).toHaveLength(1);
      expect(result.preparedVolumes[0]).toEqual({
        name: "user-workspace",
        driver: "git",
        mountPath: "/home/user/workspace",
        gitUri: "https://github.com/lancy/question.git",
        gitBranch: "run-test-run-123",
        gitToken: "test-token",
        isDynamic: true,
      });
      expect(result.errors).toHaveLength(0);
    });

    it("should return error when snapshot is missing snapshot data", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          volumes: ["user-workspace:/home/user/workspace"],
        },
        dynamic_volumes: {
          "user-workspace": {
            driver: "git",
            driver_opts: {
              uri: "https://github.com/{{user}}/question.git",
              branch: "main",
            },
          },
        },
      };

      const snapshots = [
        {
          name: "user-workspace",
          driver: "git" as const,
          mountPath: "/home/user/workspace",
        },
      ];

      vi.mocked(volumeResolver.resolveVolumes).mockReturnValue({
        volumes: [
          {
            name: "user-workspace",
            driver: "git",
            gitUri: "https://github.com/lancy/question.git",
            gitBranch: "main",
            mountPath: "/home/user/workspace",
          },
        ],
        errors: [],
      });

      const result = await volumeService.prepareVolumesFromSnapshots(
        snapshots,
        agentConfig,
        { user: "lancy" },
      );

      expect(result.preparedVolumes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain(
        "user-workspace: Failed to prepare snapshot",
      );
      expect(result.errors[0]).toContain("Git snapshot missing snapshot data");
    });

    it("should return error when snapshot is missing branch name", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          volumes: ["user-workspace:/home/user/workspace"],
        },
        dynamic_volumes: {
          "user-workspace": {
            driver: "git",
            driver_opts: {
              uri: "https://github.com/{{user}}/question.git",
              branch: "main",
            },
          },
        },
      };

      const snapshots = [
        {
          name: "user-workspace",
          driver: "git" as const,
          mountPath: "/home/user/workspace",
          snapshot: {
            branch: "",
            commitId: "abc123",
          },
        },
      ];

      vi.mocked(volumeResolver.resolveVolumes).mockReturnValue({
        volumes: [
          {
            name: "user-workspace",
            driver: "git",
            gitUri: "https://github.com/lancy/question.git",
            gitBranch: "main",
            mountPath: "/home/user/workspace",
          },
        ],
        errors: [],
      });

      const result = await volumeService.prepareVolumesFromSnapshots(
        snapshots,
        agentConfig,
        { user: "lancy" },
      );

      expect(result.preparedVolumes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Git snapshot missing branch name");
    });

    it("should prepare VM0 volume from snapshot with specific version", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          volumes: ["my-data:/workspace/data"],
        },
        dynamic_volumes: {
          "my-data": {
            driver: "vm0",
            driver_opts: {
              uri: "vm0://test-volume",
            },
          },
        },
      };

      const snapshots = [
        {
          name: "my-data",
          driver: "vm0" as const,
          mountPath: "/workspace/data",
          vm0VolumeName: "test-volume",
          snapshot: {
            versionId: "version-123-456",
          },
        },
      ];

      // Mock database query for volumeVersions
      const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([
          {
            id: "version-123-456",
            volumeId: "volume-id",
            s3Key: "user-123/test-volume/version-123-456",
          },
        ]),
      };

      globalThis.services = {
        db: mockDb as never,
      } as never;

      vi.mocked(volumeResolver.resolveVolumes).mockReturnValue({
        volumes: [
          {
            name: "my-data",
            driver: "vm0",
            vm0VolumeName: "test-volume",
            mountPath: "/workspace/data",
          },
        ],
        errors: [],
      });

      vi.mocked(s3Client.downloadS3Directory).mockResolvedValue({
        localPath: "/tmp/vm0-run-test-run-id/my-data",
        filesDownloaded: 10,
        totalBytes: 2048,
      });

      const result = await volumeService.prepareVolumesFromSnapshots(
        snapshots,
        agentConfig,
        {},
        "test-run-id",
      );

      expect(result.preparedVolumes).toHaveLength(1);
      expect(result.preparedVolumes[0]).toMatchObject({
        name: "my-data",
        driver: "vm0",
        mountPath: "/workspace/data",
        vm0VolumeName: "test-volume",
        vm0VersionId: "version-123-456",
      });
      expect(result.tempDir).toBe("/tmp/vm0-run-test-run-id");
      expect(result.errors).toHaveLength(0);

      // Verify S3 download was called with correct versioned path
      expect(s3Client.downloadS3Directory).toHaveBeenCalledWith(
        "s3://vm0-s3-user-volumes/user-123/test-volume/version-123-456",
        expect.any(String),
      );
    });

    it("should return error when VM0 snapshot is missing versionId", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          volumes: ["my-data:/workspace/data"],
        },
        dynamic_volumes: {
          "my-data": {
            driver: "vm0",
            driver_opts: {
              uri: "vm0://test-volume",
            },
          },
        },
      };

      const snapshots = [
        {
          name: "my-data",
          driver: "vm0" as const,
          mountPath: "/workspace/data",
          vm0VolumeName: "test-volume",
          // No snapshot with versionId
        },
      ];

      vi.mocked(volumeResolver.resolveVolumes).mockReturnValue({
        volumes: [
          {
            name: "my-data",
            driver: "vm0",
            vm0VolumeName: "test-volume",
            mountPath: "/workspace/data",
          },
        ],
        errors: [],
      });

      const result = await volumeService.prepareVolumesFromSnapshots(
        snapshots,
        agentConfig,
        {},
        "test-run-id",
      );

      expect(result.preparedVolumes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("VM0 snapshot missing versionId");
    });

    it("should return error when VM0 volume version not found in database", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          volumes: ["my-data:/workspace/data"],
        },
        dynamic_volumes: {
          "my-data": {
            driver: "vm0",
            driver_opts: {
              uri: "vm0://test-volume",
            },
          },
        },
      };

      const snapshots = [
        {
          name: "my-data",
          driver: "vm0" as const,
          mountPath: "/workspace/data",
          vm0VolumeName: "test-volume",
          snapshot: {
            versionId: "non-existent-version",
          },
        },
      ];

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

      vi.mocked(volumeResolver.resolveVolumes).mockReturnValue({
        volumes: [
          {
            name: "my-data",
            driver: "vm0",
            vm0VolumeName: "test-volume",
            mountPath: "/workspace/data",
          },
        ],
        errors: [],
      });

      const result = await volumeService.prepareVolumesFromSnapshots(
        snapshots,
        agentConfig,
        {},
        "test-run-id",
      );

      expect(result.preparedVolumes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain(
        'VM0 volume version "non-existent-version" not found',
      );
    });
  });
});
