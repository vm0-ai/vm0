import { describe, test, expect } from "vitest";
import {
  parseMountPath,
  replaceTemplateVars,
  resolveVolumes,
} from "../storage-resolver";
import type { AgentVolumeConfig, VolumeConfig } from "../types";

describe("parseMountPath", () => {
  test("parses valid volume declaration", () => {
    const result = parseMountPath("my-volume:/mount/path");
    expect(result.volumeName).toBe("my-volume");
    expect(result.mountPath).toBe("/mount/path");
  });

  test("trims whitespace from volume name and mount path", () => {
    const result = parseMountPath("  volume-name  :  /path/to/mount  ");
    expect(result.volumeName).toBe("volume-name");
    expect(result.mountPath).toBe("/path/to/mount");
  });

  test("handles nested mount paths", () => {
    const result = parseMountPath("data:/var/lib/app/data");
    expect(result.volumeName).toBe("data");
    expect(result.mountPath).toBe("/var/lib/app/data");
  });

  test("throws error for missing separator", () => {
    expect(() => parseMountPath("invalid-declaration")).toThrow(
      "Invalid volume declaration",
    );
  });

  test("throws error for empty volume name", () => {
    expect(() => parseMountPath(":/mount/path")).toThrow(
      "Invalid volume declaration",
    );
  });

  test("throws error for empty mount path", () => {
    expect(() => parseMountPath("volume-name:")).toThrow(
      "Invalid volume declaration",
    );
  });

  test("throws error for whitespace-only volume name", () => {
    expect(() => parseMountPath("   :/mount/path")).toThrow(
      "Invalid volume declaration",
    );
  });

  test("throws error for whitespace-only mount path", () => {
    expect(() => parseMountPath("volume-name:   ")).toThrow(
      "Invalid volume declaration",
    );
  });

  test("throws error for too many separators", () => {
    expect(() => parseMountPath("vol:path:extra")).toThrow(
      "Invalid volume declaration",
    );
  });
});

describe("replaceTemplateVars", () => {
  test("replaces single variable", () => {
    const result = replaceTemplateVars("Hello ${{ vars.name }}", {
      name: "World",
    });
    expect(result.result).toBe("Hello World");
    expect(result.missingVars).toEqual([]);
  });

  test("replaces multiple variables", () => {
    const result = replaceTemplateVars(
      "${{ vars.greeting }} ${{ vars.name }}!",
      {
        greeting: "Hello",
        name: "World",
      },
    );
    expect(result.result).toBe("Hello World!");
    expect(result.missingVars).toEqual([]);
  });

  test("reports missing variables", () => {
    const result = replaceTemplateVars("Hello ${{ vars.name }}", {});
    expect(result.result).toBe("Hello ${{ vars.name }}");
    expect(result.missingVars).toEqual(["name"]);
  });

  test("reports multiple missing variables", () => {
    const result = replaceTemplateVars(
      "${{ vars.greeting }} ${{ vars.name }}!",
      {},
    );
    expect(result.missingVars).toContain("greeting");
    expect(result.missingVars).toContain("name");
  });

  test("handles string with no variables", () => {
    const result = replaceTemplateVars("No variables here", { foo: "bar" });
    expect(result.result).toBe("No variables here");
    expect(result.missingVars).toEqual([]);
  });

  test("handles empty string", () => {
    const result = replaceTemplateVars("", { foo: "bar" });
    expect(result.result).toBe("");
    expect(result.missingVars).toEqual([]);
  });

  test("handles variable in the middle of text", () => {
    const result = replaceTemplateVars("user-${{ vars.userId }}-data", {
      userId: "123",
    });
    expect(result.result).toBe("user-123-data");
  });

  test("replaces same variable multiple times", () => {
    const result = replaceTemplateVars(
      "${{ vars.x }} + ${{ vars.x }} = 2${{ vars.x }}",
      { x: "1" },
    );
    expect(result.result).toBe("1 + 1 = 21");
  });
});

describe("resolveVolumes", () => {
  const createConfig = (
    volumes: string[] = [],
    volumeDefinitions: Record<string, VolumeConfig> = {},
    workingDir = "/workspace",
  ): AgentVolumeConfig => ({
    agents: {
      "test-agent": {
        working_dir: workingDir,
        volumes,
      },
    },
    volumes: volumeDefinitions,
  });

  test("resolves VAS volume with explicit name and version", () => {
    const config = createConfig(["data:/mnt/data"], {
      data: {
        name: "storage-name",
        version: "v1.0.0",
      },
    });

    const result = resolveVolumes(config, {}, "artifact-1", "v1");

    expect(result.volumes).toHaveLength(1);
    expect(result.volumes[0]).toEqual({
      name: "data",
      driver: "vas",
      mountPath: "/mnt/data",
      vasStorageName: "storage-name",
      vasVersion: "v1.0.0",
    });
    expect(result.errors).toHaveLength(0);
  });

  test("resolves volume with template variables in name", () => {
    const config = createConfig(["user-data:/mnt/data"], {
      "user-data": {
        name: "user-${{ vars.userId }}-storage",
        version: "latest",
      },
    });

    const result = resolveVolumes(
      config,
      { userId: "123" },
      "artifact-1",
      "v1",
    );

    expect(result.volumes).toHaveLength(1);
    expect(result.volumes[0]?.vasStorageName).toBe("user-123-storage");
    expect(result.errors).toHaveLength(0);
  });

  test("resolves volume with template variables in version", () => {
    const config = createConfig(["data:/mnt/data"], {
      data: {
        name: "storage",
        version: "${{ vars.version }}",
      },
    });

    const result = resolveVolumes(
      config,
      { version: "v2.0.0" },
      "artifact-1",
      "v1",
    );

    expect(result.volumes).toHaveLength(1);
    expect(result.volumes[0]?.vasVersion).toBe("v2.0.0");
    expect(result.errors).toHaveLength(0);
  });

  test("reports error for missing volume definition", () => {
    const config = createConfig(["undefined-vol:/mnt/data"], {});

    const result = resolveVolumes(config, {}, "artifact-1", "v1");

    expect(result.volumes).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.type).toBe("missing_definition");
    expect(result.errors[0]?.volumeName).toBe("undefined-vol");
  });

  test("reports error for missing template variable in name", () => {
    const config = createConfig(["data:/mnt/data"], {
      data: {
        name: "user-${{ vars.userId }}-storage",
        version: "v1",
      },
    });

    const result = resolveVolumes(config, {}, "artifact-1", "v1");

    expect(result.volumes).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.type).toBe("missing_variable");
    expect(result.errors[0]?.message).toContain("userId");
  });

  test("reports error for missing template variable in version", () => {
    const config = createConfig(["data:/mnt/data"], {
      data: {
        name: "storage",
        version: "${{ vars.version }}",
      },
    });

    const result = resolveVolumes(config, {}, "artifact-1", "v1");

    expect(result.volumes).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.type).toBe("missing_variable");
  });

  test("reports error for volume without name field", () => {
    const config = createConfig(["data:/mnt/data"], {
      data: {
        name: "",
        version: "v1",
      },
    });

    const result = resolveVolumes(config, {}, "artifact-1", "v1");

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.type).toBe("invalid_config");
  });

  test("reports error for volume without version field", () => {
    const config = createConfig(["data:/mnt/data"], {
      data: {
        name: "storage",
        version: "",
      },
    });

    const result = resolveVolumes(config, {}, "artifact-1", "v1");

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.type).toBe("invalid_config");
  });

  test("resolves artifact with working directory", () => {
    const config = createConfig([], {}, "/workspace");

    const result = resolveVolumes(config, {}, "my-artifact", "v1.0");

    expect(result.artifact).toEqual({
      driver: "vas",
      mountPath: "/workspace",
      vasStorageName: "my-artifact",
      vasVersion: "v1.0",
    });
  });

  test("defaults artifact version to 'latest' when not provided", () => {
    const config = createConfig([], {}, "/workspace");

    const result = resolveVolumes(config, {}, "my-artifact");

    expect(result.artifact?.vasVersion).toBe("latest");
  });

  test("allows artifact name to be optional (no error when not provided)", () => {
    const config = createConfig([], {}, "/workspace");

    const result = resolveVolumes(config, {});

    // artifactName is now optional - should return null artifact with no errors
    expect(result.errors).toHaveLength(0);
    expect(result.artifact).toBeNull();
  });

  test("skips artifact resolution when skipArtifact is true", () => {
    const config = createConfig([], {}, "/workspace");

    const result = resolveVolumes(config, {}, undefined, undefined, true);

    expect(result.artifact).toBeNull();
    expect(result.errors).toHaveLength(0);
  });

  test("applies volume version override", () => {
    const config = createConfig(["data:/mnt/data"], {
      data: {
        name: "storage",
        version: "v1",
      },
    });

    const result = resolveVolumes(config, {}, "artifact-1", "v1", false, {
      data: "v2-override",
    });

    expect(result.volumes).toHaveLength(1);
    expect(result.volumes[0]?.vasVersion).toBe("v2-override");
    expect(result.errors).toHaveLength(0);
  });

  test("only applies override to matching volume", () => {
    const config = createConfig(["data:/mnt/data", "logs:/mnt/logs"], {
      data: { name: "storage", version: "v1" },
      logs: { name: "logs-storage", version: "v1" },
    });

    const result = resolveVolumes(config, {}, "artifact-1", "v1", false, {
      data: "v2-override",
    });

    expect(result.volumes).toHaveLength(2);
    const dataVol = result.volumes.find((v) => v.name === "data");
    const logsVol = result.volumes.find((v) => v.name === "logs");
    expect(dataVol?.vasVersion).toBe("v2-override");
    expect(logsVol?.vasVersion).toBe("v1");
  });

  test("handles empty volumes array", () => {
    const config = createConfig([], {}, "/workspace");

    const result = resolveVolumes(config, {}, "artifact-1", "v1");

    expect(result.volumes).toHaveLength(0);
    expect(result.artifact).not.toBeNull();
    expect(result.errors).toHaveLength(0);
  });

  test("handles config without agents", () => {
    const config: AgentVolumeConfig = {};

    const result = resolveVolumes(config, {}, "artifact-1", "v1");

    expect(result.volumes).toHaveLength(0);
    expect(result.artifact).toBeNull();
    expect(result.errors).toHaveLength(0);
  });
});
