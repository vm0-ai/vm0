import { describe, it, expect } from "vitest";
import {
  agentDefinitionSchema,
  agentComposeContentSchema,
  artifactConfigSchema,
  artifactsArraySchema,
  MOUNT_PATH_TEMPLATE,
  ZERO_CAPABILITIES,
  ZERO_CAPABILITY_META,
} from "../composes";

const baseAgent = {
  framework: "claude-code",
};

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

describe("ZERO_CAPABILITIES", () => {
  it("should have exactly 25 capabilities", () => {
    expect(ZERO_CAPABILITIES).toHaveLength(25);
  });

  it("should follow {resource}:{action} naming pattern", () => {
    for (const cap of ZERO_CAPABILITIES) {
      expect(cap).toMatch(/^[a-z-]+:(read|write|delete)$/);
    }
  });

  it("should not include artifact capabilities", () => {
    expect(ZERO_CAPABILITIES).not.toContain("artifact:read");
    expect(ZERO_CAPABILITIES).not.toContain("artifact:write");
  });

  it("should use slack:write not integration-slack:write", () => {
    expect(ZERO_CAPABILITIES).toContain("slack:write");
    expect(ZERO_CAPABILITIES).not.toContain("integration-slack:write");
  });

  it("should include telegram read and write capabilities", () => {
    expect(ZERO_CAPABILITIES).toContain("telegram:read");
    expect(ZERO_CAPABILITIES).toContain("telegram:write");
  });

  it("should include phone read and write capabilities", () => {
    expect(ZERO_CAPABILITIES).toContain("phone:read");
    expect(ZERO_CAPABILITIES).toContain("phone:write");
  });

  it("should include file read and write capabilities", () => {
    expect(ZERO_CAPABILITIES).toContain("file:read");
    expect(ZERO_CAPABILITIES).toContain("file:write");
  });

  it("should include remote-agent read and write capabilities", () => {
    expect(ZERO_CAPABILITIES).toContain("remote-agent:read");
    expect(ZERO_CAPABILITIES).toContain("remote-agent:write");
  });

  it("should include local-browser read and write capabilities", () => {
    expect(ZERO_CAPABILITIES).toContain("local-browser:read");
    expect(ZERO_CAPABILITIES).toContain("local-browser:write");
  });

  it("should include hosted-site read and write capabilities", () => {
    expect(ZERO_CAPABILITIES).toContain("host:read");
    expect(ZERO_CAPABILITIES).toContain("host:write");
  });
});

describe("ZERO_CAPABILITY_META", () => {
  it("should have metadata for every ZERO_CAPABILITY", () => {
    for (const cap of ZERO_CAPABILITIES) {
      expect(ZERO_CAPABILITY_META[cap]).toBeDefined();
      expect(ZERO_CAPABILITY_META[cap].group).toBeTruthy();
      expect(ZERO_CAPABILITY_META[cap].label).toBeTruthy();
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

  it("accepts the ${{ working_dir }} template", () => {
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
        { name: "b", mount_path: MOUNT_PATH_TEMPLATE },
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
