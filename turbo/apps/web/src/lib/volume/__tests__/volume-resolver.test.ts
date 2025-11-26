import { describe, it, expect } from "vitest";
import {
  parseMountPath,
  replaceTemplateVars,
  resolveVolumes,
} from "../volume-resolver";
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
    const result = replaceTemplateVars("s3://bucket/users/{{userId}}", {
      userId: "test-user-123",
    });

    expect(result).toEqual({
      uri: "s3://bucket/users/test-user-123",
      missingVars: [],
    });
  });

  it("should replace multiple template variables", () => {
    const result = replaceTemplateVars(
      "s3://{{bucket}}/users/{{userId}}/files",
      {
        bucket: "my-bucket",
        userId: "test-user",
      },
    );

    expect(result).toEqual({
      uri: "s3://my-bucket/users/test-user/files",
      missingVars: [],
    });
  });

  it("should detect missing variables", () => {
    const result = replaceTemplateVars("s3://bucket/users/{{userId}}", {});

    expect(result).toEqual({
      uri: "s3://bucket/users/{{userId}}",
      missingVars: ["userId"],
    });
  });

  it("should detect multiple missing variables", () => {
    const result = replaceTemplateVars("s3://{{bucket}}/users/{{userId}}", {});

    expect(result.missingVars).toEqual(["bucket", "userId"]);
  });

  it("should handle URIs without template variables", () => {
    const result = replaceTemplateVars("s3://bucket/static/path", {});

    expect(result).toEqual({
      uri: "s3://bucket/static/path",
      missingVars: [],
    });
  });

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
        vm0VolumeName: "mnist",
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
              uri: "invalid://mnist", // Wrong protocol
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
              uri: "mnist", // Missing vm0:// prefix
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
});

describe("resolveVolumes", () => {
  it("should resolve static VM0 volume", () => {
    const config: AgentVolumeConfig = {
      agent: {
        volumes: ["dataset:/workspace/data"],
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
    expect(result.volumes[0]).toEqual({
      name: "dataset",
      driver: "vm0",
      mountPath: "/workspace/data",
      vm0VolumeName: "my-dataset",
    });
    expect(result.errors).toHaveLength(0);
  });

  it("should resolve multiple VM0 volumes", () => {
    const config: AgentVolumeConfig = {
      agent: {
        volumes: ["dataset1:/data1", "dataset2:/data2"],
      },
      volumes: {
        dataset1: {
          driver: "vm0",
          driver_opts: {
            uri: "vm0://my-dataset-1",
          },
        },
        dataset2: {
          driver: "vm0",
          driver_opts: {
            uri: "vm0://my-dataset-2",
          },
        },
      },
    };

    const result = resolveVolumes(config);

    expect(result.volumes).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it("should detect missing volume definition", () => {
    const config: AgentVolumeConfig = {
      agent: {
        volumes: ["unknown-volume:/path"],
      },
    };

    const result = resolveVolumes(config);

    expect(result.volumes).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      volumeName: "unknown-volume",
      type: "missing_definition",
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

  it("should reject git driver for volumes (git only for artifacts)", () => {
    const config = {
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
    } as AgentVolumeConfig;

    const result = resolveVolumes(config);

    expect(result.volumes).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      volumeName: "repo",
      type: "invalid_uri",
      message:
        "Unsupported volume driver: git. Only vm0 driver is supported for volumes.",
    });
  });

  it("should handle unsupported driver", () => {
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
    } as AgentVolumeConfig;

    const result = resolveVolumes(config);

    expect(result.volumes).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      volumeName: "custom-volume",
      type: "invalid_uri",
    });
  });

  describe("Artifact resolution", () => {
    it("should resolve VM0 artifact with artifact key", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/workspace",
            driver: "vm0",
          },
        },
      };

      const result = resolveVolumes(config, {}, "my-artifact");

      expect(result.artifact).not.toBeNull();
      expect(result.artifact).toMatchObject({
        driver: "vm0",
        mountPath: "/workspace",
        vm0VolumeName: "my-artifact",
      });
      expect(result.errors).toHaveLength(0);
    });

    it("should resolve Git artifact", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/workspace",
            driver: "git",
            driver_opts: {
              uri: "https://github.com/user/repo.git",
              branch: "main",
              token: "ghp_token123",
            },
          },
        },
      };

      const result = resolveVolumes(config);

      expect(result.artifact).not.toBeNull();
      expect(result.artifact).toMatchObject({
        driver: "git",
        mountPath: "/workspace",
        gitUri: "https://github.com/user/repo.git",
        gitBranch: "main",
        gitToken: "ghp_token123",
      });
      expect(result.errors).toHaveLength(0);
    });

    it("should use main as default branch for Git artifact", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/workspace",
            driver: "git",
            driver_opts: {
              uri: "https://github.com/user/repo.git",
            },
          },
        },
      };

      const result = resolveVolumes(config);

      expect(result.artifact?.gitBranch).toBe("main");
    });

    it("should replace template variables in Git artifact URI", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/workspace",
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

      expect(result.artifact?.gitUri).toBe(
        "https://github.com/testuser/testrepo.git",
      );
      expect(result.errors).toHaveLength(0);
    });

    it("should error on missing template variables in Git artifact URI", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/workspace",
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

    it("should error when volume mounts to working_dir", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["dataset:/workspace"],
          artifact: {
            working_dir: "/workspace",
            driver: "vm0",
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

      const result = resolveVolumes(config, {}, "my-artifact");

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        volumeName: "dataset",
        type: "working_dir_conflict",
        message:
          'Volume "dataset" cannot mount to working_dir (/workspace). Only artifact can mount to working_dir.',
      });
    });

    it("should error on invalid Git URL for artifact", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/workspace",
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

    it("should not require artifact key for Git artifact", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/workspace",
            driver: "git",
            driver_opts: {
              uri: "https://github.com/user/repo.git",
            },
          },
        },
      };

      // No artifact key provided, but Git artifact should still resolve
      const result = resolveVolumes(config);

      expect(result.artifact).not.toBeNull();
      expect(result.artifact?.driver).toBe("git");
      expect(result.errors).toHaveLength(0);
    });

    it("should return null artifact when VM0 artifact has no artifact key (valid case)", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/workspace",
            driver: "vm0",
          },
        },
      };

      // No artifact key provided for VM0 artifact - this is valid, just means no artifact mounted
      const result = resolveVolumes(config);

      expect(result.artifact).toBeNull();
      expect(result.errors).toHaveLength(0); // No error, just no artifact
    });

    it("should preserve token with environment variable pattern", () => {
      const config: AgentVolumeConfig = {
        agent: {
          artifact: {
            working_dir: "/workspace",
            driver: "git",
            driver_opts: {
              uri: "https://github.com/user/repo.git",
              branch: "main",
              token: "${CI_GITHUB_TOKEN}",
            },
          },
        },
      };

      const result = resolveVolumes(config);

      expect(result.artifact?.gitToken).toBe("${CI_GITHUB_TOKEN}");
      expect(result.errors).toHaveLength(0);
    });
  });
});
