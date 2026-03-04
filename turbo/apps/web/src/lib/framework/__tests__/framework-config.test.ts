import { describe, it, expect } from "vitest";
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
    it("returns :latest image for claude-code", () => {
      expect(resolveFrameworkImage("claude-code")).toBe(
        "vm0/claude-code:latest",
      );
    });

    it("returns :latest image for codex", () => {
      expect(resolveFrameworkImage("codex")).toBe("vm0/codex:latest");
    });
  });
});
