import { describe, it, expect } from "vitest";
import {
  agentDefinitionSchema,
  agentComposeContentSchema,
  artifactConfigSchema,
  artifactsArraySchema,
  expandMountPath,
  MOUNT_PATH_TEMPLATE,
} from "../composes";
import { CANONICAL_WORKING_DIR } from "../runners";

const baseAgent = {
  framework: "claude-code",
};

describe("expandMountPath", () => {
  it("expands omitted and template mount paths to canonical working dir", () => {
    expect(expandMountPath(undefined)).toBe(CANONICAL_WORKING_DIR);
    expect(expandMountPath(MOUNT_PATH_TEMPLATE)).toBe(CANONICAL_WORKING_DIR);
  });

  it("preserves explicit mount paths", () => {
    expect(expandMountPath("/custom/path")).toBe("/custom/path");
  });
});

describe("agentDefinitionSchema strips unknown experimental_capabilities", () => {
  it("silently strips experimental_capabilities from input", () => {
    const result = agentDefinitionSchema.safeParse({
      ...baseAgent,
      experimental_capabilities: ["agent:read", "agent:write"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("experimental_capabilities");
    }
  });
});

describe("artifactConfigSchema", () => {
  it("accepts explicit absolute mount_path", () => {
    const r = artifactConfigSchema.safeParse({
      name: "a",
      version: "v1",
      mount_path: "/custom/path",
    });
    expect(r.success).toBe(true);
  });

  it("accepts the working_dir template", () => {
    const r = artifactConfigSchema.safeParse({
      name: "a",
      mount_path: MOUNT_PATH_TEMPLATE,
    });
    expect(r.success).toBe(true);
  });

  it("accepts entries with no version and no mount_path", () => {
    const r = artifactConfigSchema.safeParse({ name: "a" });
    expect(r.success).toBe(true);
  });

  it("rejects empty name", () => {
    const r = artifactConfigSchema.safeParse({ name: "" });
    expect(r.success).toBe(false);
  });

  it("rejects relative mount_path", () => {
    const r = artifactConfigSchema.safeParse({
      name: "a",
      mount_path: "relative/path",
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty mount_path", () => {
    const r = artifactConfigSchema.safeParse({
      name: "a",
      mount_path: "",
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown template tokens", () => {
    const r = artifactConfigSchema.safeParse({
      name: "a",
      mount_path: "${{ home }}",
    });
    expect(r.success).toBe(false);
  });
});

describe("artifactsArraySchema duplicate-name refinement", () => {
  it("rejects duplicate names", () => {
    const r = artifactsArraySchema.safeParse([
      { name: "a", mount_path: "/x" },
      { name: "a", mount_path: "/y" },
    ]);
    expect(r.success).toBe(false);
  });

  it("accepts unique names", () => {
    const r = artifactsArraySchema.safeParse([
      { name: "a", mount_path: "/x" },
      { name: "b", mount_path: "/y" },
    ]);
    expect(r.success).toBe(true);
  });
});

describe("agentComposeContentSchema.artifacts", () => {
  const baseCompose = {
    version: "1",
    agents: { "my-agent": { framework: "claude-code" } },
  };

  it("accepts a compose with no artifacts field", () => {
    const r = agentComposeContentSchema.safeParse(baseCompose);
    expect(r.success).toBe(true);
  });

  it("accepts a compose with an artifacts array", () => {
    const r = agentComposeContentSchema.safeParse({
      ...baseCompose,
      artifacts: [
        { name: "a", mount_path: "/custom/path" },
        { name: "b", mount_path: "/another/path" },
        { name: "c" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects duplicate artifact names at the compose level", () => {
    const r = agentComposeContentSchema.safeParse({
      ...baseCompose,
      artifacts: [{ name: "a" }, { name: "a" }],
    });
    expect(r.success).toBe(false);
  });
});
