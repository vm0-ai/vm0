import { describe, it, expect } from "vitest";
import {
  agentDefinitionSchema,
  VALID_CAPABILITIES,
  CAPABILITY_META,
  ZERO_CAPABILITIES,
  ZERO_CAPABILITY_META,
} from "../composes";

const baseAgent = {
  framework: "claude-code",
};

describe("VALID_CAPABILITIES", () => {
  it("contains 9 capabilities", () => {
    expect(VALID_CAPABILITIES).toHaveLength(9);
  });

  it("all follow resource:action format", () => {
    for (const cap of VALID_CAPABILITIES) {
      expect(cap).toMatch(/^[a-z-]+:(read|write)$/);
    }
  });
});

describe("CAPABILITY_META", () => {
  it("has an entry for every VALID_CAPABILITIES member", () => {
    for (const cap of VALID_CAPABILITIES) {
      expect(CAPABILITY_META[cap]).toBeDefined();
      expect(CAPABILITY_META[cap].group).toBeTruthy();
      expect(CAPABILITY_META[cap].label).toBeTruthy();
    }
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

describe("ZERO_CAPABILITIES", () => {
  it("should have exactly 7 capabilities", () => {
    expect(ZERO_CAPABILITIES).toHaveLength(7);
  });

  it("should follow {resource}:{action} naming pattern", () => {
    for (const cap of ZERO_CAPABILITIES) {
      expect(cap).toMatch(/^[a-z-]+:(read|write)$/);
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
