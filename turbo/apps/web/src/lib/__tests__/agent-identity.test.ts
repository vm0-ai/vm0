import { describe, it, expect } from "vitest";
import { formatAgentIdentityPrompt } from "../agent-identity";

describe("formatAgentIdentityPrompt", () => {
  it("should return empty string when all fields are null", () => {
    expect(
      formatAgentIdentityPrompt({
        displayName: null,
        description: null,
        sound: null,
      }),
    ).toBe("");
  });

  it("should include displayName", () => {
    const result = formatAgentIdentityPrompt({
      displayName: "My Agent",
      description: null,
      sound: null,
    });
    expect(result).toContain("You are My Agent.");
    expect(result).toMatch(/^# Agent Identity/);
  });

  it("should include description", () => {
    const result = formatAgentIdentityPrompt({
      displayName: null,
      description: "A helpful coding assistant",
      sound: null,
    });
    expect(result).toContain("A helpful coding assistant");
  });

  it("should include sound", () => {
    const result = formatAgentIdentityPrompt({
      displayName: null,
      description: null,
      sound: "friendly",
    });
    expect(result).toContain("Communication style: friendly");
  });

  it("should combine all fields", () => {
    const result = formatAgentIdentityPrompt({
      displayName: "Bot",
      description: "Helps with tasks",
      sound: "professional",
    });
    expect(result).toContain("You are Bot.");
    expect(result).toContain("Helps with tasks");
    expect(result).toContain("Communication style: professional");
  });
});
