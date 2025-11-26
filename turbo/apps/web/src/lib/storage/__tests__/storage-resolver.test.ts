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
    const result = replaceTemplateVars("vm0://{{storageName}}", {
      storageName: "test-storage-123",
    });

    expect(result).toEqual({
      uri: "vm0://test-storage-123",
      missingVars: [],
    });
  });

  it("should replace multiple template variables", () => {
    const result = replaceTemplateVars("vm0://{{userId}}-{{storageName}}", {
      userId: "user1",
      storageName: "my-storage",
    });

    expect(result).toEqual({
      uri: "vm0://user1-my-storage",
      missingVars: [],
    });
  });

  it("should detect missing variables", () => {
    const result = replaceTemplateVars("vm0://{{storageName}}", {});

    expect(result).toEqual({
      uri: "vm0://{{storageName}}",
      missingVars: ["storageName"],
    });
  });

  it("should detect multiple missing variables", () => {
    const result = replaceTemplateVars("vm0://{{userId}}/{{storageName}}", {});

    expect(result.missingVars).toEqual(["userId", "storageName"]);
  });

  it("should handle URIs without template variables", () => {
    const result = replaceTemplateVars("vm0://static-storage", {});

    expect(result).toEqual({
      uri: "vm0://static-storage",
      missingVars: [],
    });
  });
});

describe("resolveVolumes", () => {
  describe("VM0 volumes", () => {
    it("should resolve VM0 volume with valid URI", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["dataset:/workspace/data"],
        },
        volumes: {
          dataset: {
            driver: "vm0",
            driver_opts: {
              uri: "vm0://mnist",
            },
          },
        },
      };

      const result = resolveVolumes(config);

      expect(result.volumes).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
      expect(result.volumes[0]).toMatchObject({
        name: "dataset",
        driver: "vm0",
        mountPath: "/workspace/data",
        vm0StorageName: "mnist",
      });
    });

    it("should resolve VM0 volume with template variables", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["dataset:/workspace/data"],
        },
        volumes: {
          dataset: {
            driver: "vm0",
            driver_opts: {
              uri: "vm0://{{datasetName}}",
            },
          },
        },
      };

      const result = resolveVolumes(config, { datasetName: "cifar10" });

      expect(result.volumes).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
      expect(result.volumes[0]).toMatchObject({
        name: "dataset",
        driver: "vm0",
        mountPath: "/workspace/data",
        vm0StorageName: "cifar10",
      });
    });

    it("should error on missing template variables in VM0 URI", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["dataset:/workspace/data"],
        },
        volumes: {
          dataset: {
            driver: "vm0",
            driver_opts: {
              uri: "vm0://{{datasetName}}",
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

    it("should error on invalid VM0 URI format", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["dataset:/workspace/data"],
        },
        volumes: {
          dataset: {
            driver: "vm0",
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
          "Invalid VM0 URI: invalid://mnist. Expected format: vm0://volume-name",
      });
    });

    it("should error on missing vm0:// prefix", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["dataset:/workspace/data"],
        },
        volumes: {
          dataset: {
            driver: "vm0",
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
    it("should resolve VM0 artifact when artifact key is provided", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/home/user/workspace",
            driver: "vm0",
          },
        },
      };

      const result = resolveVolumes(config, {}, "my-artifact-storage");

      expect(result.artifact).not.toBeNull();
      expect(result.artifact).toMatchObject({
        driver: "vm0",
        mountPath: "/home/user/workspace",
        vm0StorageName: "my-artifact-storage",
      });
      expect(result.errors).toHaveLength(0);
    });

    it("should return null artifact when no artifact key provided for VM0 driver", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/home/user/workspace",
            driver: "vm0",
          },
        },
      };

      const result = resolveVolumes(config); // No artifact key

      expect(result.artifact).toBeNull();
      expect(result.errors).toHaveLength(0);
    });

    it("should resolve Git artifact with full configuration", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/home/user/workspace",
            driver: "git",
            driver_opts: {
              uri: "https://github.com/user/repo.git",
              branch: "main",
              token: "ghp_test123",
            },
          },
        },
      };

      const result = resolveVolumes(config);

      expect(result.artifact).not.toBeNull();
      expect(result.artifact).toMatchObject({
        driver: "git",
        mountPath: "/home/user/workspace",
        gitUri: "https://github.com/user/repo.git",
        gitBranch: "main",
        gitToken: "ghp_test123",
      });
      expect(result.errors).toHaveLength(0);
    });

    it("should resolve Git artifact with short format URL", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/home/user/workspace",
            driver: "git",
            driver_opts: {
              uri: "user/repo",
              branch: "develop",
            },
          },
        },
      };

      const result = resolveVolumes(config);

      expect(result.artifact).not.toBeNull();
      expect(result.artifact).toMatchObject({
        driver: "git",
        mountPath: "/home/user/workspace",
        gitUri: "https://github.com/user/repo.git",
        gitBranch: "develop",
      });
      expect(result.errors).toHaveLength(0);
    });

    it("should use main as default branch for Git artifacts", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/home/user/workspace",
            driver: "git",
            driver_opts: {
              uri: "https://github.com/user/repo.git",
            },
          },
        },
      };

      const result = resolveVolumes(config);

      expect(result.artifact?.gitBranch).toBe("main");
      expect(result.errors).toHaveLength(0);
    });

    it("should replace template variables in Git URI", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/home/user/workspace",
            driver: "git",
            driver_opts: {
              uri: "https://github.com/{{user}}/{{project}}.git",
              branch: "main",
            },
          },
        },
      };

      const result = resolveVolumes(config, {
        user: "testuser",
        project: "testrepo",
      });

      expect(result.artifact).toMatchObject({
        gitUri: "https://github.com/testuser/testrepo.git",
        gitBranch: "main",
      });
      expect(result.errors).toHaveLength(0);
    });

    it("should replace template variables in Git branch", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/home/user/workspace",
            driver: "git",
            driver_opts: {
              uri: "https://github.com/user/repo.git",
              branch: "{{branchName}}",
            },
          },
        },
      };

      const result = resolveVolumes(config, {
        branchName: "feature-123",
      });

      expect(result.artifact?.gitBranch).toBe("feature-123");
      expect(result.errors).toHaveLength(0);
    });

    it("should error when Git artifact is missing URI", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/home/user/workspace",
            driver: "git",
            driver_opts: {},
          },
        },
      };

      const result = resolveVolumes(config);

      expect(result.artifact).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        volumeName: "artifact",
        message: "Git artifact requires driver_opts.uri",
        type: "invalid_uri",
      });
    });

    it("should error on invalid Git URL (SSH format)", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/home/user/workspace",
            driver: "git",
            driver_opts: {
              uri: "git@github.com:user/repo.git",
              branch: "main",
            },
          },
        },
      };

      const result = resolveVolumes(config);

      expect(result.artifact).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        volumeName: "artifact",
        type: "invalid_uri",
        message:
          "Invalid Git URL: git@github.com:user/repo.git. Only HTTPS URLs are supported.",
      });
    });

    it("should error on missing template variables in Git URI", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/home/user/workspace",
            driver: "git",
            driver_opts: {
              uri: "https://github.com/{{user}}/repo.git",
              branch: "main",
            },
          },
        },
      };

      const result = resolveVolumes(config, {});

      expect(result.artifact).toBeNull();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        volumeName: "artifact",
        type: "missing_variable",
        message: "Missing required variables: user",
      });
    });
  });

  describe("volume and artifact combination", () => {
    it("should resolve both volumes and artifact together", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["dataset:/workspace/data"],
          artifact: {
            working_dir: "/home/user/workspace",
            driver: "git",
            driver_opts: {
              uri: "https://github.com/user/repo.git",
              branch: "main",
            },
          },
        },
        volumes: {
          dataset: {
            driver: "vm0",
            driver_opts: {
              uri: "vm0://my-dataset",
            },
          },
        },
      };

      const result = resolveVolumes(config);

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
            driver: "git",
            driver_opts: {
              uri: "https://github.com/user/repo.git",
              branch: "main",
            },
          },
        },
        volumes: {
          dataset: {
            driver: "vm0",
            driver_opts: {
              uri: "vm0://my-dataset",
            },
          },
        },
      };

      const result = resolveVolumes(config);

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
    // as a VM0 volume with uri vm0://<volumeName>
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
      driver: "vm0",
      mountPath: "/path",
      vm0StorageName: "my-data",
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
        "Unsupported volume driver: nfs. Only vm0 driver is supported for volumes.",
    });
  });
});
