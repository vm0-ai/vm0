import { describe, it, expect } from "vitest";
import {
  agentDefinitionSchema,
  agentComposeApiContentSchema,
  VALID_CAPABILITIES,
  CAPABILITY_META,
} from "../composes";

const baseAgent = {
  framework: "claude-code",
};

function wrapInCompose(agentOverrides: Record<string, unknown>) {
  return {
    version: "1.0",
    agents: {
      "test-agent": { ...baseAgent, ...agentOverrides },
    },
  };
}

describe("VALID_CAPABILITIES", () => {
  it("contains 8 capabilities", () => {
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

describe("experimental_capabilities in agentDefinitionSchema", () => {
  it("accepts valid capabilities array", () => {
    const result = agentDefinitionSchema.safeParse({
      ...baseAgent,
      experimental_capabilities: ["artifact:read", "artifact:write"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a single valid capability", () => {
    const result = agentDefinitionSchema.safeParse({
      ...baseAgent,
      experimental_capabilities: ["agent:read"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty array", () => {
    const result = agentDefinitionSchema.safeParse({
      ...baseAgent,
      experimental_capabilities: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts missing field (backward compatibility)", () => {
    const result = agentDefinitionSchema.safeParse(baseAgent);
    expect(result.success).toBe(true);
  });

  it("rejects invalid capability name", () => {
    const result = agentDefinitionSchema.safeParse({
      ...baseAgent,
      experimental_capabilities: ["invalid:capability"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects deprecated storage:read as direct value", () => {
    const result = agentDefinitionSchema.safeParse({
      ...baseAgent,
      experimental_capabilities: ["storage:read"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate capabilities", () => {
    const result = agentDefinitionSchema.safeParse({
      ...baseAgent,
      experimental_capabilities: ["artifact:read", "artifact:read"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        "Duplicate capabilities are not allowed",
      );
    }
  });
});

describe("experimental_capabilities in agentComposeApiContentSchema", () => {
  it("accepts compose with valid capabilities", () => {
    const result = agentComposeApiContentSchema.safeParse(
      wrapInCompose({
        experimental_capabilities: [
          "agent:read",
          "artifact:write",
          "agent-run:read",
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts compose without capabilities", () => {
    const result = agentComposeApiContentSchema.safeParse(wrapInCompose({}));
    expect(result.success).toBe(true);
  });

  it("rejects compose with invalid capability", () => {
    const result = agentComposeApiContentSchema.safeParse(
      wrapInCompose({
        experimental_capabilities: ["not-a-capability"],
      }),
    );
    expect(result.success).toBe(false);
  });
});
