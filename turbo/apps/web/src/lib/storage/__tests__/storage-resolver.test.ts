import { describe, it, expect } from "vitest";
import {
  parseMountPath,
  replaceTemplateVars,
  resolveVolumes,
} from "../storage-resolver";
import type { AgentVolumeConfig } from "../types";

describe("parseMountPath", () => {
  it("should parse valid mount path declaration", () => {
    const result = parseMountPath("user-workspace:/home/user/workspace");

    expect(result).toEqual({
      volumeName: "user-workspace",
      mountPath: "/home/user/workspace",
    });
  });

  it("should handle volume names with hyphens", () => {
    const result = parseMountPath("claude-system:/home/user/.claude");

    expect(result).toEqual({
      volumeName: "claude-system",
      mountPath: "/home/user/.claude",
    });
  });

  it("should throw error for invalid format", () => {
    expect(() => parseMountPath("invalid-format")).toThrow(
      "Invalid volume declaration",
    );
  });

  it("should throw error for missing mount path", () => {
    expect(() => parseMountPath("volume-name:")).toThrow(
      "Invalid volume declaration",
    );
  });
});

describe("replaceTemplateVars", () => {
  it("should replace single template variable", () => {
    const result = replaceTemplateVars("{{storageName}}", {
      storageName: "test-storage-123",
    });

    expect(result).toEqual({
      result: "test-storage-123",
      missingVars: [],
    });
  });

  it("should replace multiple template variables", () => {
    const result = replaceTemplateVars("{{userId}}-{{storageName}}", {
      userId: "user1",
      storageName: "my-storage",
    });

    expect(result).toEqual({
      result: "user1-my-storage",
      missingVars: [],
    });
  });

  it("should detect missing variables", () => {
    const result = replaceTemplateVars("{{storageName}}", {});

    expect(result).toEqual({
      result: "{{storageName}}",
      missingVars: ["storageName"],
    });
  });

  it("should detect multiple missing variables", () => {
    const result = replaceTemplateVars("{{userId}}/{{storageName}}", {});

    expect(result.missingVars).toEqual(["userId", "storageName"]);
  });

  it("should handle strings without template variables", () => {
    const result = replaceTemplateVars("static-storage", {});

    expect(result).toEqual({
      result: "static-storage",
      missingVars: [],
    });
  });
});

describe("resolveVolumes", () => {
  describe("VAS volumes", () => {
    it("should resolve VAS volume with explicit definition", () => {
      const config: AgentVolumeConfig = {
        agents: [
          {
            volumes: ["dataset:/workspace/data"],
            working_dir: "/home/user/workspace",
          },
        ],
        volumes: {
          dataset: {
            name: "mnist",
            version: "latest",
          },
        },
      };

      const result = resolveVolumes(config, {}, "my-artifact", "latest");

      expect(result.volumes).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
      expect(result.volumes[0]).toMatchObject({
        name: "dataset",
        driver: "vas",
        mountPath: "/workspace/data",
        vasStorageName: "mnist",
        vasVersion: "latest",
      });
    });

    it("should resolve VAS volume with template variables in name", () => {
      const config: AgentVolumeConfig = {
        agents: [
          {
            volumes: ["dataset:/workspace/data"],
            working_dir: "/home/user/workspace",
          },
        ],
        volumes: {
          dataset: {
            name: "{{datasetName}}",
            version: "latest",
          },
        },
      };

      const result = resolveVolumes(
        config,
        { datasetName: "cifar10" },
        "my-artifact",
        "latest",
      );

      expect(result.volumes).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
      expect(result.volumes[0]).toMatchObject({
        name: "dataset",
        driver: "vas",
        mountPath: "/workspace/data",
        vasStorageName: "cifar10",
        vasVersion: "latest",
      });
    });

    it("should error on missing template variables in volume name", () => {
      const config: AgentVolumeConfig = {
        agents: [
          {
            volumes: ["dataset:/workspace/data"],
            working_dir: "/home/user/workspace",
          },
        ],
        volumes: {
          dataset: {
            name: "{{datasetName}}",
            version: "latest",
          },
        },
      };

      const result = resolveVolumes(config, {}, "my-artifact", "latest");

      expect(result.volumes).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatchObject({
        volumeName: "dataset",
        type: "missing_variable",
        message: "Missing required variables: datasetName",
      });
    });

    it("should error when volume is not defined in volumes section", () => {
      const config: AgentVolumeConfig = {
        agents: [
          {
            volumes: ["dataset:/workspace/data"],
            working_dir: "/home/user/workspace",
          },
        ],
        // No volumes section
      };

      const result = resolveVolumes(config, {}, "my-artifact", "latest");

      expect(result.volumes).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatchObject({
        volumeName: "dataset",
        type: "missing_definition",
      });
    });
  });

  describe("artifact resolution", () => {
    it("should resolve VAS artifact when artifact name is provided", () => {
      const config: AgentVolumeConfig = {
        agents: [
          {
            working_dir: "/home/user/workspace",
          },
        ],
      };

      const result = resolveVolumes(
        config,
        {},
        "my-artifact-storage",
        "abc123",
      );

      expect(result.artifact).not.toBeNull();
      expect(result.artifact).toMatchObject({
        driver: "vas",
        mountPath: "/home/user/workspace",
        vasStorageName: "my-artifact-storage",
        vasVersion: "abc123",
      });
      expect(result.errors).toHaveLength(0);
    });

    it("should use latest as default version when not specified", () => {
      const config: AgentVolumeConfig = {
        agents: [
          {
            working_dir: "/home/user/workspace",
          },
        ],
      };

      const result = resolveVolumes(config, {}, "my-artifact-storage");

      expect(result.artifact).not.toBeNull();
      expect(result.artifact).toMatchObject({
        driver: "vas",
        mountPath: "/home/user/workspace",
        vasStorageName: "my-artifact-storage",
        vasVersion: "latest",
      });
      expect(result.errors).toHaveLength(0);
    });

    it("should error when no artifact name provided", () => {
      const config: AgentVolumeConfig = {
        agents: [
          {
            working_dir: "/home/user/workspace",
          },
        ],
      };

      const result = resolveVolumes(config); // No artifact name

      expect(result.artifact).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        volumeName: "artifact",
        type: "missing_artifact_name",
        message:
          "Artifact name is required. Use --artifact-name flag to specify artifact.",
      });
    });

    it("should skip artifact when skipArtifact is true", () => {
      const config: AgentVolumeConfig = {
        agents: [
          {
            working_dir: "/home/user/workspace",
          },
        ],
      };

      const result = resolveVolumes(
        config,
        {},
        undefined,
        undefined,
        true, // skipArtifact
      );

      expect(result.artifact).toBeNull();
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("volume and artifact combination", () => {
    it("should resolve both volumes and artifact together", () => {
      const config: AgentVolumeConfig = {
        agents: [
          {
            volumes: ["dataset:/workspace/data"],
            working_dir: "/home/user/workspace",
          },
        ],
        volumes: {
          dataset: {
            name: "my-dataset",
            version: "v1",
          },
        },
      };

      const result = resolveVolumes(config, {}, "my-artifact", "latest");

      expect(result.volumes).toHaveLength(1);
      expect(result.artifact).not.toBeNull();
      expect(result.errors).toHaveLength(0);
    });
  });

  it("should return empty result for no volume declarations", () => {
    const config: AgentVolumeConfig = {
      agents: [
        {
          working_dir: "/home/user/workspace",
        },
      ],
    };

    const result = resolveVolumes(
      config,
      {},
      undefined,
      undefined,
      true, // skipArtifact to avoid artifact error
    );

    expect(result.volumes).toHaveLength(0);
    expect(result.artifact).toBeNull();
    expect(result.errors).toHaveLength(0);
  });
});
