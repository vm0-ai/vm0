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

    it("should prepare volumes successfully", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          volumes: ["data:/workspace/data"],
        },
        volumes: {
          data: {
            driver: "s3fs",
            driver_opts: {
              uri: "s3://test-bucket/data",
              region: "us-east-1",
            },
          },
        },
      };

      vi.mocked(volumeResolver.resolveVolumes).mockReturnValue({
        volumes: [
          {
            name: "data",
            driver: "s3fs",
            s3Uri: "s3://test-bucket/data",
            mountPath: "/workspace/data",
            region: "us-east-1",
          },
        ],
        errors: [],
      });

      vi.mocked(s3Client.downloadS3Directory).mockResolvedValue({
        localPath: "/tmp/vm0-run-test-run-id/data",
        filesDownloaded: 5,
        totalBytes: 1024,
      });

      const result = await volumeService.prepareVolumes(
        agentConfig,
        {},
        "test-run-id",
      );

      expect(result.preparedVolumes).toHaveLength(1);
      expect(result.preparedVolumes[0]).toEqual({
        name: "data",
        driver: "s3fs",
        localPath: "/tmp/vm0-run-test-run-id/data",
        mountPath: "/workspace/data",
        s3Uri: "s3://test-bucket/data",
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

    it("should handle download errors", async () => {
      const agentConfig: AgentVolumeConfig = {
        agent: {
          volumes: ["data:/workspace/data"],
        },
        volumes: {
          data: {
            driver: "s3fs",
            driver_opts: {
              uri: "s3://test-bucket/data",
              region: "us-east-1",
            },
          },
        },
      };

      vi.mocked(volumeResolver.resolveVolumes).mockReturnValue({
        volumes: [
          {
            name: "data",
            driver: "s3fs",
            s3Uri: "s3://test-bucket/data",
            mountPath: "/workspace/data",
            region: "us-east-1",
          },
        ],
        errors: [],
      });

      vi.mocked(s3Client.downloadS3Directory).mockRejectedValue(
        new Error("S3 download failed"),
      );

      const result = await volumeService.prepareVolumes(
        agentConfig,
        {},
        "test-run-id",
      );

      expect(result.preparedVolumes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("data: Failed to prepare");
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

    it("should upload volumes to sandbox", async () => {
      const mockSandbox = {
        files: {
          write: vi.fn(),
        },
      };

      const preparedVolumes: PreparedVolume[] = [
        {
          name: "data",
          driver: "s3fs",
          localPath: "/tmp/vm0-run-test/data",
          mountPath: "/workspace/data",
          s3Uri: "s3://test-bucket/data",
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
  });
});
