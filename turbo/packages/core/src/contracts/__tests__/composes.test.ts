import { describe, it, expect } from "vitest";
import {
  agentDefinitionSchema,
  agentComposeApiContentSchema,
  VALID_CAPABILITIES,
  normalizeCapabilities,
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
    expect(VALID_CAPABILITIES).toHaveLength(8);
  });

  it("all follow resource:action format", () => {
    for (const cap of VALID_CAPABILITIES) {
      expect(cap).toMatch(/^[a-z-]+:(read|write)$/);
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

describe("normalizeCapabilities", () => {
  it("passes through current capabilities unchanged", () => {
    expect(normalizeCapabilities(["artifact:read", "agent:write"])).toEqual(
      expect.arrayContaining(["artifact:read", "agent:write"]),
    );
  });

  it("normalizes volume:read to agent:read", () => {
    expect(normalizeCapabilities(["volume:read"])).toEqual(["agent:read"]);
  });

  it("normalizes volume:write to agent:write", () => {
    expect(normalizeCapabilities(["volume:write"])).toEqual(["agent:write"]);
  });

  it("normalizes storage:read to artifact:read", () => {
    expect(normalizeCapabilities(["storage:read"])).toEqual(["artifact:read"]);
  });

  it("normalizes storage:write to artifact:write", () => {
    expect(normalizeCapabilities(["storage:write"])).toEqual([
      "artifact:write",
    ]);
  });

  it("normalizes memory:write to artifact:write", () => {
    expect(normalizeCapabilities(["memory:write"])).toEqual(["artifact:write"]);
  });

  it("deduplicates when multiple old caps map to same new cap", () => {
    const result = normalizeCapabilities(["storage:read", "memory:read"]);
    expect(result).toEqual(["artifact:read"]);
  });

  it("handles mixed old and new capabilities", () => {
    const result = normalizeCapabilities([
      "volume:read",
      "agent:write",
      "storage:write",
    ]);
    expect(result).toHaveLength(3);
    expect(result).toContain("agent:read");
    expect(result).toContain("agent:write");
    expect(result).toContain("artifact:write");
  });

  it("drops unknown capabilities", () => {
    expect(normalizeCapabilities(["unknown:cap"])).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(normalizeCapabilities([])).toEqual([]);
  });
});
