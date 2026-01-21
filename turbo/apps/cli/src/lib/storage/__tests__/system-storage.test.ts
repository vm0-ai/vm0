import { describe, it, expect } from "vitest";
import { getInstructionsFilename } from "../system-storage";

describe("getInstructionsFilename", () => {
  it("returns CLAUDE.md for claude-code provider", () => {
    expect(getInstructionsFilename("claude-code")).toBe("CLAUDE.md");
  });

  it("returns AGENTS.md for codex provider", () => {
    expect(getInstructionsFilename("codex")).toBe("AGENTS.md");
  });

  it("returns CLAUDE.md for undefined provider", () => {
    expect(getInstructionsFilename(undefined)).toBe("CLAUDE.md");
  });

  it("throws for unknown framework", () => {
    expect(() => getInstructionsFilename("unknown-provider")).toThrow(
      'Unsupported framework "unknown-provider"',
    );
  });
});
