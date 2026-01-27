import { describe, it, expect, afterEach, vi } from "vitest";
import { SUPPORTED_FRAMEWORKS, isSupportedFramework } from "@vm0/core";
import {
  resolveFrameworkImage,
  resolveFrameworkWorkingDir,
} from "../framework-config";

describe("framework-config", () => {
  describe("SUPPORTED_FRAMEWORKS", () => {
    it("contains claude-code and codex", () => {
      expect(SUPPORTED_FRAMEWORKS).toContain("claude-code");
      expect(SUPPORTED_FRAMEWORKS).toContain("codex");
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

    it("returns false for unknown framework", () => {
      expect(isSupportedFramework("unknown")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isSupportedFramework("")).toBe(false);
    });

    it("returns false for similar but incorrect names", () => {
      expect(isSupportedFramework("claude")).toBe(false);
      expect(isSupportedFramework("claude-code-v2")).toBe(false);
      expect(isSupportedFramework("Codex")).toBe(false);
    });
  });

  describe("resolveFrameworkWorkingDir", () => {
    it("returns /home/user/workspace for claude-code", () => {
      expect(resolveFrameworkWorkingDir("claude-code")).toBe(
        "/home/user/workspace",
      );
    });

    it("returns /home/user/workspace for codex", () => {
      expect(resolveFrameworkWorkingDir("codex")).toBe("/home/user/workspace");
    });
  });

  describe("resolveFrameworkImage", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    describe("without apps", () => {
      it("returns production image for claude-code when VERCEL_ENV is production", () => {
        vi.stubEnv("VERCEL_ENV", "production");
        expect(resolveFrameworkImage("claude-code")).toBe(
          "vm0/claude-code:latest",
        );
      });

      it("returns dev image for claude-code when VERCEL_ENV is not production", () => {
        vi.stubEnv("VERCEL_ENV", "preview");
        expect(resolveFrameworkImage("claude-code")).toBe(
          "vm0/claude-code:dev",
        );
      });

      it("returns dev image for claude-code when VERCEL_ENV is undefined", () => {
        vi.stubEnv("VERCEL_ENV", "");
        expect(resolveFrameworkImage("claude-code")).toBe(
          "vm0/claude-code:dev",
        );
      });

      it("returns production image for codex when VERCEL_ENV is production", () => {
        vi.stubEnv("VERCEL_ENV", "production");
        expect(resolveFrameworkImage("codex")).toBe("vm0/codex:latest");
      });

      it("returns dev image for codex when VERCEL_ENV is not production", () => {
        vi.stubEnv("VERCEL_ENV", "development");
        expect(resolveFrameworkImage("codex")).toBe("vm0/codex:dev");
      });
    });

    describe("with github app", () => {
      it("returns github-specific production image for claude-code with github app", () => {
        vi.stubEnv("VERCEL_ENV", "production");
        expect(resolveFrameworkImage("claude-code", ["github"])).toBe(
          "vm0/claude-code-github:latest",
        );
      });

      it("returns github-specific dev image for claude-code with github:dev app", () => {
        vi.stubEnv("VERCEL_ENV", "production");
        expect(resolveFrameworkImage("claude-code", ["github:dev"])).toBe(
          "vm0/claude-code-github:dev",
        );
      });

      it("returns github-specific latest image for claude-code with github:latest app", () => {
        vi.stubEnv("VERCEL_ENV", "development");
        expect(resolveFrameworkImage("claude-code", ["github:latest"])).toBe(
          "vm0/claude-code-github:latest",
        );
      });

      it("returns github-specific production image for codex with github app", () => {
        vi.stubEnv("VERCEL_ENV", "production");
        expect(resolveFrameworkImage("codex", ["github"])).toBe(
          "vm0/codex-github:latest",
        );
      });

      it("returns github-specific dev image for codex with github:dev app", () => {
        vi.stubEnv("VERCEL_ENV", "production");
        expect(resolveFrameworkImage("codex", ["github:dev"])).toBe(
          "vm0/codex-github:dev",
        );
      });
    });

    describe("with unknown app", () => {
      it("falls back to default image when app is not recognized", () => {
        vi.stubEnv("VERCEL_ENV", "production");
        expect(resolveFrameworkImage("claude-code", ["unknown-app"])).toBe(
          "vm0/claude-code:latest",
        );
      });
    });

    describe("with empty apps array", () => {
      it("returns default image when apps array is empty", () => {
        vi.stubEnv("VERCEL_ENV", "production");
        expect(resolveFrameworkImage("claude-code", [])).toBe(
          "vm0/claude-code:latest",
        );
      });
    });
  });
});
