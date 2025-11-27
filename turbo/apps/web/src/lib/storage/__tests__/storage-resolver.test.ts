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
    const result = replaceTemplateVars("vas://{{storageName}}", {
      storageName: "test-storage-123",
    });

    expect(result).toEqual({
      uri: "vas://test-storage-123",
      missingVars: [],
    });
  });

  it("should replace multiple template variables", () => {
    const result = replaceTemplateVars("vas://{{userId}}-{{storageName}}", {
      userId: "user1",
      storageName: "my-storage",
    });

    expect(result).toEqual({
      uri: "vas://user1-my-storage",
      missingVars: [],
    });
  });

  it("should detect missing variables", () => {
    const result = replaceTemplateVars("vas://{{storageName}}", {});

    expect(result).toEqual({
      uri: "vas://{{storageName}}",
      missingVars: ["storageName"],
    });
  });

  it("should detect multiple missing variables", () => {
    const result = replaceTemplateVars("vas://{{userId}}/{{storageName}}", {});

    expect(result.missingVars).toEqual(["userId", "storageName"]);
  });

  it("should handle URIs without template variables", () => {
    const result = replaceTemplateVars("vas://static-storage", {});

    expect(result).toEqual({
      uri: "vas://static-storage",
      missingVars: [],
    });
  });
});

describe("resolveVolumes", () => {
  describe("VAS volumes", () => {
    it("should resolve VAS volume with valid URI", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["dataset:/workspace/data"],
        },
        volumes: {
          dataset: {
            driver: "vas",
            driver_opts: {
              uri: "vas://mnist",
            },
          },
        },
      };

      const result = resolveVolumes(config);

      expect(result.volumes).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
      expect(result.volumes[0]).toMatchObject({
        name: "dataset",
        driver: "vas",
        mountPath: "/workspace/data",
        vasStorageName: "mnist",
      });
    });

    it("should resolve VAS volume with template variables", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["dataset:/workspace/data"],
        },
        volumes: {
          dataset: {
            driver: "vas",
            driver_opts: {
              uri: "vas://{{datasetName}}",
            },
          },
        },
      };

      const result = resolveVolumes(config, { datasetName: "cifar10" });

      expect(result.volumes).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
      expect(result.volumes[0]).toMatchObject({
        name: "dataset",
        driver: "vas",
        mountPath: "/workspace/data",
        vasStorageName: "cifar10",
      });
    });

    it("should error on missing template variables in VAS URI", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["dataset:/workspace/data"],
        },
        volumes: {
          dataset: {
            driver: "vas",
            driver_opts: {
              uri: "vas://{{datasetName}}",
            },
          },
        },
      };

      const result = resolveVolumes(config); // No dynamic vars provided

      expect(result.volumes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        volumeName: "dataset",
        type: "missing_variable",
        message: "Missing required variables: datasetName",
      });
    });

    it("should error on invalid VAS URI format", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["dataset:/workspace/data"],
        },
        volumes: {
          dataset: {
            driver: "vas",
            driver_opts: {
              uri: "invalid://mnist",
            },
          },
        },
      };

      const result = resolveVolumes(config);

      expect(result.volumes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        volumeName: "dataset",
        type: "invalid_uri",
        message:
          "Invalid VAS URI: invalid://mnist. Expected format: vas://volume-name",
      });
    });

    it("should error on missing vas:// prefix", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["dataset:/workspace/data"],
        },
        volumes: {
          dataset: {
            driver: "vas",
            driver_opts: {
              uri: "mnist",
            },
          },
        },
      };

      const result = resolveVolumes(config);

      expect(result.volumes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        volumeName: "dataset",
        type: "invalid_uri",
      });
    });
  });

  describe("artifact resolution", () => {
    it("should resolve VAS artifact when artifact key is provided", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/home/user/workspace",
            driver: "vas",
          },
        },
      };

      const result = resolveVolumes(config, {}, "my-artifact-storage");

      expect(result.artifact).not.toBeNull();
      expect(result.artifact).toMatchObject({
        driver: "vas",
        mountPath: "/home/user/workspace",
        vasStorageName: "my-artifact-storage",
      });
      expect(result.errors).toHaveLength(0);
    });

    it("should error when no artifact key provided for VAS driver", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/home/user/workspace",
            driver: "vas",
          },
        },
      };

      const result = resolveVolumes(config); // No artifact key

      expect(result.artifact).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        volumeName: "artifact",
        type: "missing_artifact_key",
        message:
          "VAS artifact configured but no artifact key provided. Use --artifact flag to specify artifact.",
      });
    });

    it("should default to VAS driver when driver not specified", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/home/user/workspace",
          },
        },
      };

      const result = resolveVolumes(config, {}, "my-artifact");

      expect(result.artifact).not.toBeNull();
      expect(result.artifact).toMatchObject({
        driver: "vas",
        mountPath: "/home/user/workspace",
        vasStorageName: "my-artifact",
      });
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("volume and artifact combination", () => {
    it("should resolve both volumes and artifact together", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["dataset:/workspace/data"],
          artifact: {
            working_dir: "/home/user/workspace",
            driver: "vas",
          },
        },
        volumes: {
          dataset: {
            driver: "vas",
            driver_opts: {
              uri: "vas://my-dataset",
            },
          },
        },
      };

      const result = resolveVolumes(config, {}, "my-artifact");

      expect(result.volumes).toHaveLength(1);
      expect(result.artifact).not.toBeNull();
      expect(result.errors).toHaveLength(0);
    });

    it("should error when volume tries to mount to artifact working_dir", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["dataset:/home/user/workspace"], // Same as working_dir
          artifact: {
            working_dir: "/home/user/workspace",
            driver: "vas",
          },
        },
        volumes: {
          dataset: {
            driver: "vas",
            driver_opts: {
              uri: "vas://my-dataset",
            },
          },
        },
      };

      const result = resolveVolumes(config, {}, "my-artifact");

      expect(result.volumes).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        volumeName: "dataset",
        type: "working_dir_conflict",
        message:
          'Volume "dataset" cannot mount to working_dir (/home/user/workspace). Only artifact can mount to working_dir.',
      });
    });
  });

  it("should auto-resolve volume by name when no explicit definition", () => {
    // When no volumes section defines the volume, it should auto-resolve
    // as a VAS volume with uri vas://<volumeName>
    const config: AgentVolumeConfig = {
      agent: {
        volumes: ["my-data:/path"],
      },
    };

    const result = resolveVolumes(config);

    expect(result.volumes).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    expect(result.volumes[0]).toMatchObject({
      name: "my-data",
      driver: "vas",
      mountPath: "/path",
      vasStorageName: "my-data",
    });
  });

  it("should return empty result for no volume declarations", () => {
    const config: AgentVolumeConfig = {
      agent: {},
    };

    const result = resolveVolumes(config);

    expect(result.volumes).toHaveLength(0);
    expect(result.artifact).toBeNull();
    expect(result.errors).toHaveLength(0);
  });

  it("should error on unsupported volume driver", () => {
    // Intentionally use invalid driver type to test error handling
    const config = {
      agent: {
        volumes: ["custom-volume:/path"],
      },
      volumes: {
        "custom-volume": {
          driver: "nfs",
          driver_opts: {
            uri: "nfs://server/path",
          },
        },
      },
    } as unknown as AgentVolumeConfig;

    const result = resolveVolumes(config);

    expect(result.volumes).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      volumeName: "custom-volume",
      type: "invalid_uri",
      message:
        "Unsupported volume driver: nfs. Only vas driver is supported for volumes.",
    });
  });
});
