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
});

describe("resolveVolumes", () => {
  it("should resolve static volume", () => {
    const config: AgentVolumeConfig = {
      agent: {
        volumes: ["claude-system:/home/user/.claude"],
      },
      volumes: {
        "claude-system": {
          driver: "s3fs",
          driver_opts: {
            uri: "s3://my-bucket/claude-files",
            region: "us-west-2",
          },
        },
      },
    };

    const result = resolveVolumes(config);

    expect(result.volumes).toHaveLength(1);
    expect(result.volumes[0]).toEqual({
      name: "claude-system",
      s3Uri: "s3://my-bucket/claude-files",
      mountPath: "/home/user/.claude",
      region: "us-west-2",
    });
    expect(result.errors).toHaveLength(0);
  });

  it("should resolve dynamic volume with template variables", () => {
    const config: AgentVolumeConfig = {
      agent: {
        volumes: ["user-workspace:/home/user/workspace"],
      },
      dynamic_volumes: {
        "user-workspace": {
          driver: "s3fs",
          driver_opts: {
            uri: "s3://my-bucket/users/{{userId}}",
            region: "us-west-2",
          },
        },
      },
    };

    const result = resolveVolumes(config, { userId: "test-user-123" });

    expect(result.volumes).toHaveLength(1);
    expect(result.volumes[0]).toEqual({
      name: "user-workspace",
      s3Uri: "s3://my-bucket/users/test-user-123",
      mountPath: "/home/user/workspace",
      region: "us-west-2",
    });
    expect(result.errors).toHaveLength(0);
  });

  it("should resolve multiple volumes", () => {
    const config: AgentVolumeConfig = {
      agent: {
        volumes: [
          "claude-system:/home/user/.claude",
          "user-workspace:/home/user/workspace",
        ],
      },
      volumes: {
        "claude-system": {
          driver: "s3fs",
          driver_opts: {
            uri: "s3://my-bucket/claude-files",
            region: "us-west-2",
          },
        },
      },
      dynamic_volumes: {
        "user-workspace": {
          driver: "s3fs",
          driver_opts: {
            uri: "s3://my-bucket/users/{{userId}}",
            region: "us-west-2",
          },
        },
      },
    };

    const result = resolveVolumes(config, { userId: "test-user" });

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

  it("should detect missing template variables", () => {
    const config: AgentVolumeConfig = {
      agent: {
        volumes: ["user-workspace:/path"],
      },
      dynamic_volumes: {
        "user-workspace": {
          driver: "s3fs",
          driver_opts: {
            uri: "s3://bucket/users/{{userId}}",
            region: "us-west-2",
          },
        },
      },
    };

    const result = resolveVolumes(config, {});

    expect(result.volumes).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      volumeName: "user-workspace",
      type: "missing_variable",
      message: "Missing required variables: userId",
    });
  });

  it("should return empty result for no volume declarations", () => {
    const config: AgentVolumeConfig = {
      agent: {},
    };

    const result = resolveVolumes(config);

    expect(result.volumes).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("should handle unsupported driver", () => {
    const config: AgentVolumeConfig = {
      agent: {
        volumes: ["custom-volume:/path"],
      },
      volumes: {
        "custom-volume": {
          driver: "nfs",
          driver_opts: {
            uri: "nfs://server/path",
            region: "us-west-2",
          },
        },
      },
    };

    const result = resolveVolumes(config);

    expect(result.volumes).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      volumeName: "custom-volume",
      type: "invalid_uri",
      message: "Unsupported volume driver: nfs. Only s3fs is supported.",
    });
  });

  it("should reject deprecated 'dynamic-volumes' format", () => {
    const config = {
      agent: {
        volumes: ["user-workspace:/path"],
      },
      "dynamic-volumes": {
        "user-workspace": {
          driver: "s3fs",
          driver_opts: {
            uri: "s3://bucket/users/{{userId}}",
            region: "us-west-2",
          },
        },
      },
    };

    expect(() => resolveVolumes(config as AgentVolumeConfig)).toThrow(
      "Configuration error: 'dynamic-volumes' is deprecated. Please use 'dynamic_volumes' instead (snake_case)",
    );
  });
});
