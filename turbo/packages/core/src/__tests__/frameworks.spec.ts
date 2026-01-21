import { describe, it, expect } from "vitest";
import {
  SUPPORTED_FRAMEWORKS,
  isSupportedFramework,
  assertSupportedFramework,
  getValidatedFramework,
  getFrameworkDisplayName,
} from "../frameworks";

describe("frameworks", () => {
  describe("SUPPORTED_FRAMEWORKS", () => {
    it("includes claude-code and codex", () => {
      expect(SUPPORTED_FRAMEWORKS).toContain("claude-code");
      expect(SUPPORTED_FRAMEWORKS).toContain("codex");
    });

    it("has exactly 2 frameworks", () => {
      expect(SUPPORTED_FRAMEWORKS).toHaveLength(2);
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
      expect(() => assertSupportedFramework("claude-code")).not.toThrow();
    });

    it("does not throw for codex", () => {
      expect(() => assertSupportedFramework("codex")).not.toThrow();
    });

    it("throws for undefined", () => {
      expect(() => assertSupportedFramework(undefined)).toThrow(
        'Unsupported framework "undefined"',
      );
    });

    it("throws for unknown framework", () => {
      expect(() => assertSupportedFramework("unknown")).toThrow(
        'Unsupported framework "unknown"',
      );
    });

    it("includes context in error message", () => {
      expect(() =>
        assertSupportedFramework("unknown", "getInstructionsFilename"),
      ).toThrow('Unsupported framework "unknown" in getInstructionsFilename');
    });

    it("lists supported frameworks in error message", () => {
      expect(() => assertSupportedFramework("unknown")).toThrow(
        "Supported frameworks: claude-code, codex",
      );
    });
  });

  describe("getValidatedFramework", () => {
    it("returns claude-code for undefined", () => {
      expect(getValidatedFramework(undefined)).toBe("claude-code");
    });

    it("returns claude-code for claude-code", () => {
      expect(getValidatedFramework("claude-code")).toBe("claude-code");
    });

    it("returns codex for codex", () => {
      expect(getValidatedFramework("codex")).toBe("codex");
    });

    it("throws for unknown framework", () => {
      expect(() => getValidatedFramework("unknown")).toThrow(
        'Unsupported framework "unknown"',
      );
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
      expect(() => getFrameworkDisplayName("unknown")).toThrow(
        'Unsupported framework "unknown"',
      );
    });
  });
});
