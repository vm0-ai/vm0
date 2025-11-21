import { describe, it, expect } from "vitest";
import { resolveVolumes } from "../volume-resolver";
import type { AgentVolumeConfig } from "../types";

describe("volume-resolver git driver", () => {
  describe("resolveVolumes with git driver", () => {
    it("should resolve git volume with all options", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["workspace:/home/user/workspace"],
        },
        volumes: {
          workspace: {
            driver: "git",
            driver_opts: {
              repo: "https://github.com/owner/repo.git",
              branch: "main",
              token: "encrypted:AES256:test:test:test",
            },
          },
        },
      };

      const result = resolveVolumes(config);

      expect(result.errors).toEqual([]);
      expect(result.volumes).toHaveLength(1);
      expect(result.volumes[0]).toEqual({
        name: "workspace",
        uri: "github://owner/repo@main",
        driver: "git",
        mountPath: "/home/user/workspace",
        metadata: {
          repo: "owner/repo",
          branch: "main",
          token: "encrypted:AES256:test:test:test",
        },
      });
    });

    it("should use default branch when not specified", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["workspace:/home/user/workspace"],
        },
        volumes: {
          workspace: {
            driver: "git",
            driver_opts: {
              repo: "https://github.com/owner/repo.git",
              token: "encrypted:AES256:test:test:test",
            },
          },
        },
      };

      const result = resolveVolumes(config);

      expect(result.errors).toEqual([]);
      expect(result.volumes[0]?.uri).toBe("github://owner/repo@main");
      expect(result.volumes[0]?.metadata.branch).toBe("main");
    });

    it("should support template variables in repo URL", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["workspace:/home/user/workspace"],
        },
        dynamic_volumes: {
          workspace: {
            driver: "git",
            driver_opts: {
              repo: "https://github.com/{{org}}/{{project}}.git",
              branch: "main",
              token: "encrypted:AES256:test:test:test",
            },
          },
        },
      };

      const result = resolveVolumes(config, {
        org: "myorg",
        project: "myproject",
      });

      expect(result.errors).toEqual([]);
      expect(result.volumes[0]?.uri).toBe("github://myorg/myproject@main");
      expect(result.volumes[0]?.metadata.repo).toBe("myorg/myproject");
    });

    it("should support template variables in branch", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["workspace:/home/user/workspace"],
        },
        dynamic_volumes: {
          workspace: {
            driver: "git",
            driver_opts: {
              repo: "https://github.com/owner/repo.git",
              branch: "{{branch}}",
              token: "encrypted:AES256:test:test:test",
            },
          },
        },
      };

      const result = resolveVolumes(config, { branch: "develop" });

      expect(result.errors).toEqual([]);
      expect(result.volumes[0]?.uri).toBe("github://owner/repo@develop");
      expect(result.volumes[0]?.metadata.branch).toBe("develop");
    });

    it("should error when repo is missing", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["workspace:/home/user/workspace"],
        },
        volumes: {
          workspace: {
            driver: "git",
            driver_opts: {
              token: "encrypted:AES256:test:test:test",
            },
          },
        },
      };

      const result = resolveVolumes(config);

      expect(result.volumes).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({
        volumeName: "workspace",
        message:
          "Git driver requires 'repo' option (format: https://github.com/owner/repo.git)",
        type: "missing_option",
      });
    });

    it("should error when token is missing", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["workspace:/home/user/workspace"],
        },
        volumes: {
          workspace: {
            driver: "git",
            driver_opts: {
              repo: "https://github.com/owner/repo.git",
            },
          },
        },
      };

      const result = resolveVolumes(config);

      expect(result.volumes).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({
        volumeName: "workspace",
        message: "Git driver requires 'token' option (encrypted GitHub token)",
        type: "missing_option",
      });
    });

    it("should error when template variables are missing", () => {
      const config: AgentVolumeConfig = {
        agent: {
          volumes: ["workspace:/home/user/workspace"],
        },
        dynamic_volumes: {
          workspace: {
            driver: "git",
            driver_opts: {
              repo: "https://github.com/{{org}}/{{project}}.git",
              token: "encrypted:AES256:test:test:test",
            },
          },
        },
      };

      const result = resolveVolumes(config);

      expect(result.volumes).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.type).toBe("missing_variable");
      expect(result.errors[0]?.message).toContain("org");
      expect(result.errors[0]?.message).toContain("project");
    });
  });
});
