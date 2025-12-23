import { describe, it, expect } from "vitest";
import {
  SUPPORTED_PROVIDERS,
  isSupportedProvider,
  assertSupportedProvider,
  getValidatedProvider,
  getProviderDisplayName,
} from "../providers";

describe("providers", () => {
  describe("SUPPORTED_PROVIDERS", () => {
    it("includes claude-code and codex", () => {
      expect(SUPPORTED_PROVIDERS).toContain("claude-code");
      expect(SUPPORTED_PROVIDERS).toContain("codex");
    });

    it("has exactly 2 providers", () => {
      expect(SUPPORTED_PROVIDERS).toHaveLength(2);
    });
  });

  describe("isSupportedProvider", () => {
    it("returns true for claude-code", () => {
      expect(isSupportedProvider("claude-code")).toBe(true);
    });

    it("returns true for codex", () => {
      expect(isSupportedProvider("codex")).toBe(true);
    });

    it("returns false for undefined", () => {
      expect(isSupportedProvider(undefined)).toBe(false);
    });

    it("returns false for unknown provider", () => {
      expect(isSupportedProvider("unknown")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isSupportedProvider("")).toBe(false);
    });
  });

  describe("assertSupportedProvider", () => {
    it("does not throw for claude-code", () => {
      expect(() => assertSupportedProvider("claude-code")).not.toThrow();
    });

    it("does not throw for codex", () => {
      expect(() => assertSupportedProvider("codex")).not.toThrow();
    });

    it("throws for undefined", () => {
      expect(() => assertSupportedProvider(undefined)).toThrow(
        'Unsupported provider "undefined"',
      );
    });

    it("throws for unknown provider", () => {
      expect(() => assertSupportedProvider("unknown")).toThrow(
        'Unsupported provider "unknown"',
      );
    });

    it("includes context in error message", () => {
      expect(() =>
        assertSupportedProvider("unknown", "getInstructionsFilename"),
      ).toThrow('Unsupported provider "unknown" in getInstructionsFilename');
    });

    it("lists supported providers in error message", () => {
      expect(() => assertSupportedProvider("unknown")).toThrow(
        "Supported providers: claude-code, codex",
      );
    });
  });

  describe("getValidatedProvider", () => {
    it("returns claude-code for undefined", () => {
      expect(getValidatedProvider(undefined)).toBe("claude-code");
    });

    it("returns claude-code for claude-code", () => {
      expect(getValidatedProvider("claude-code")).toBe("claude-code");
    });

    it("returns codex for codex", () => {
      expect(getValidatedProvider("codex")).toBe("codex");
    });

    it("throws for unknown provider", () => {
      expect(() => getValidatedProvider("unknown")).toThrow(
        'Unsupported provider "unknown"',
      );
    });
  });

  describe("getProviderDisplayName", () => {
    it('returns "Claude Code" for claude-code', () => {
      expect(getProviderDisplayName("claude-code")).toBe("Claude Code");
    });

    it('returns "Codex" for codex', () => {
      expect(getProviderDisplayName("codex")).toBe("Codex");
    });

    it("throws for unknown provider", () => {
      expect(() => getProviderDisplayName("unknown")).toThrow(
        'Unsupported provider "unknown"',
      );
    });
  });
});
