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
      experimental_capabilities: ["storage:read", "storage:write"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a single valid capability", () => {
    const result = agentDefinitionSchema.safeParse({
      ...baseAgent,
      experimental_capabilities: ["storage:read"],
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

  it("rejects duplicate capabilities", () => {
    const result = agentDefinitionSchema.safeParse({
      ...baseAgent,
      experimental_capabilities: ["storage:read", "storage:read"],
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
          "storage:read",
          "storage:write",
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
    expect(normalizeCapabilities(["storage:read", "agent:write"])).toEqual(
      expect.arrayContaining(["storage:read", "agent:write"]),
    );
  });

  it("normalizes volume:read to storage:read", () => {
    expect(normalizeCapabilities(["volume:read"])).toEqual(["storage:read"]);
  });

  it("normalizes volume:write to storage:write", () => {
    expect(normalizeCapabilities(["volume:write"])).toEqual(["storage:write"]);
  });

  it("normalizes artifact:read to storage:read", () => {
    expect(normalizeCapabilities(["artifact:read"])).toEqual(["storage:read"]);
  });

  it("normalizes memory:write to storage:write", () => {
    expect(normalizeCapabilities(["memory:write"])).toEqual(["storage:write"]);
  });

  it("deduplicates when multiple old caps map to same new cap", () => {
    const result = normalizeCapabilities([
      "volume:read",
      "artifact:read",
      "memory:read",
    ]);
    expect(result).toEqual(["storage:read"]);
  });

  it("handles mixed old and new capabilities", () => {
    const result = normalizeCapabilities([
      "volume:read",
      "agent:write",
      "storage:write",
    ]);
    expect(result).toHaveLength(3);
    expect(result).toContain("storage:read");
    expect(result).toContain("agent:write");
    expect(result).toContain("storage:write");
  });

  it("drops unknown capabilities", () => {
    expect(normalizeCapabilities(["unknown:cap"])).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(normalizeCapabilities([])).toEqual([]);
  });
});
