import { describe, it, expect } from "vitest";
import { agentDefinitionSchema } from "@vm0/api-contracts/contracts/composes";
import {
  SUPPORTED_FRAMEWORKS,
  isSupportedFramework,
  assertSupportedFramework,
  getValidatedFramework,
  getFrameworkDisplayName,
  getInstructionsFilename,
} from "../frameworks";

describe("frameworks", () => {
  describe("SUPPORTED_FRAMEWORKS", () => {
    it("includes claude-code", () => {
      expect(SUPPORTED_FRAMEWORKS).toContain("claude-code");
    });

    it("includes codex", () => {
      expect(SUPPORTED_FRAMEWORKS).toContain("codex");
    });

    it("has exactly 2 frameworks", () => {
      expect(SUPPORTED_FRAMEWORKS).toHaveLength(2);
    });

    it("matches the composes contract framework enum", () => {
      const schemaFrameworks = agentDefinitionSchema.shape.framework.options;
      expect([...SUPPORTED_FRAMEWORKS].sort()).toEqual(
        [...schemaFrameworks].sort(),
      );
    });
  });

  describe("isSupportedFramework", () => {
    it("returns true for claude-code", () => {
      expect(isSupportedFramework("claude-code")).toBe(true);
    });

    it("returns true for codex", () => {
      expect(isSupportedFramework("codex")).toBe(true);
    });

    it("returns false for undefined", () => {
      expect(isSupportedFramework(undefined)).toBe(false);
    });

    it("returns false for unknown framework", () => {
      expect(isSupportedFramework("unknown")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isSupportedFramework("")).toBe(false);
    });
  });

  describe("assertSupportedFramework", () => {
    it("does not throw for claude-code", () => {
      expect(() => {
        return assertSupportedFramework("claude-code");
      }).not.toThrow();
    });

    it("throws for undefined", () => {
      expect(() => {
        return assertSupportedFramework(undefined);
      }).toThrow('Unsupported framework "undefined"');
    });

    it("throws for unknown framework", () => {
      expect(() => {
        return assertSupportedFramework("unknown");
      }).toThrow('Unsupported framework "unknown"');
    });

    it("includes context in error message", () => {
      expect(() => {
        return assertSupportedFramework("unknown", "getInstructionsFilename");
      }).toThrow('Unsupported framework "unknown" in getInstructionsFilename');
    });

    it("lists supported frameworks in error message", () => {
      expect(() => {
        return assertSupportedFramework("unknown");
      }).toThrow("Supported frameworks: claude-code, codex");
    });
  });

  describe("getValidatedFramework", () => {
    it("returns claude-code for undefined", () => {
      expect(getValidatedFramework(undefined)).toBe("claude-code");
    });

    it("returns claude-code for claude-code", () => {
      expect(getValidatedFramework("claude-code")).toBe("claude-code");
    });

    it("throws for unknown framework", () => {
      expect(() => {
        return getValidatedFramework("unknown");
      }).toThrow('Unsupported framework "unknown"');
    });
  });

  describe("getFrameworkDisplayName", () => {
    it('returns "Claude Code" for claude-code', () => {
      expect(getFrameworkDisplayName("claude-code")).toBe("Claude Code");
    });

    it('returns "Codex" for codex', () => {
      expect(getFrameworkDisplayName("codex")).toBe("Codex");
    });

    it("throws for unknown framework", () => {
      expect(() => {
        return getFrameworkDisplayName("unknown");
      }).toThrow('Unsupported framework "unknown"');
    });
  });

  describe("getInstructionsFilename", () => {
    it('returns "CLAUDE.md" for claude-code', () => {
      expect(getInstructionsFilename("claude-code")).toBe("CLAUDE.md");
    });

    it('returns "AGENTS.md" for codex', () => {
      expect(getInstructionsFilename("codex")).toBe("AGENTS.md");
    });

    it('returns "CLAUDE.md" for undefined (defaults to claude-code)', () => {
      expect(getInstructionsFilename(undefined)).toBe("CLAUDE.md");
    });

    it("throws for unknown framework", () => {
      expect(() => {
        return getInstructionsFilename("unknown");
      }).toThrow('Unsupported framework "unknown"');
    });
  });
});
