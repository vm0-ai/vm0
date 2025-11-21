import { describe, it, expect } from "vitest";
import {
  validateGitUrl,
  normalizeGitUrl,
  buildAuthenticatedUrl,
  sanitizeGitUrlForLogging,
  buildGitCloneCommand,
} from "../git-client";

describe("git-client", () => {
  describe("validateGitUrl", () => {
    it("should validate HTTPS Git URLs", () => {
      expect(validateGitUrl("https://github.com/user/repo.git")).toBe(true);
      expect(validateGitUrl("https://gitlab.com/user/repo.git")).toBe(true);
    });

    it("should reject non-HTTPS URLs", () => {
      expect(validateGitUrl("http://github.com/user/repo.git")).toBe(false);
      expect(validateGitUrl("git@github.com:user/repo.git")).toBe(false);
      expect(validateGitUrl("ssh://git@github.com/user/repo.git")).toBe(false);
    });

    it("should reject URLs without .git suffix", () => {
      expect(validateGitUrl("https://github.com/user/repo")).toBe(false);
    });
  });

  describe("normalizeGitUrl", () => {
    it("should normalize GitHub short format to full URL", () => {
      expect(normalizeGitUrl("user/repo")).toBe(
        "https://github.com/user/repo.git",
      );
      expect(normalizeGitUrl("org/project")).toBe(
        "https://github.com/org/project.git",
      );
    });

    it("should handle full URLs with .git suffix", () => {
      expect(normalizeGitUrl("https://github.com/user/repo.git")).toBe(
        "https://github.com/user/repo.git",
      );
    });

    it("should add .git suffix to full URLs without it", () => {
      expect(normalizeGitUrl("https://github.com/user/repo")).toBe(
        "https://github.com/user/repo.git",
      );
    });

    it("should handle URLs with leading/trailing slashes", () => {
      expect(normalizeGitUrl("/user/repo/")).toBe(
        "https://github.com/user/repo.git",
      );
    });
  });

  describe("buildAuthenticatedUrl", () => {
    it("should add token to URL", () => {
      const url = "https://github.com/user/repo.git";
      const token = "ghp_test123";
      const result = buildAuthenticatedUrl(url, token);
      expect(result).toBe("https://ghp_test123@github.com/user/repo.git");
    });

    it("should return original URL when no token provided", () => {
      const url = "https://github.com/user/repo.git";
      const result = buildAuthenticatedUrl(url);
      expect(result).toBe(url);
    });

    it("should return original URL when token is undefined", () => {
      const url = "https://github.com/user/repo.git";
      const result = buildAuthenticatedUrl(url, undefined);
      expect(result).toBe(url);
    });
  });

  describe("sanitizeGitUrlForLogging", () => {
    it("should mask token in authenticated URL", () => {
      const url = "https://ghp_test123@github.com/user/repo.git";
      const result = sanitizeGitUrlForLogging(url);
      expect(result).toBe("https://***@github.com/user/repo.git");
    });

    it("should mask both username and password", () => {
      const url = "https://user:password@github.com/user/repo.git";
      const result = sanitizeGitUrlForLogging(url);
      expect(result).toBe("https://***:***@github.com/user/repo.git");
    });

    it("should return original URL if no credentials", () => {
      const url = "https://github.com/user/repo.git";
      const result = sanitizeGitUrlForLogging(url);
      expect(result).toBe(url);
    });

    it("should handle invalid URLs gracefully", () => {
      const url = "not-a-url";
      const result = sanitizeGitUrlForLogging(url);
      expect(result).toBe(url);
    });
  });

  describe("buildGitCloneCommand", () => {
    it("should build clone command with all parameters", () => {
      const url = "https://github.com/user/repo.git";
      const branch = "main";
      const mountPath = "/workspace/repo";
      const result = buildGitCloneCommand(url, branch, mountPath);
      expect(result).toBe(
        `git clone --single-branch --branch "main" --depth 1 "https://github.com/user/repo.git" "/workspace/repo"`,
      );
    });

    it("should handle different branches", () => {
      const url = "https://github.com/user/repo.git";
      const branch = "develop";
      const mountPath = "/workspace/repo";
      const result = buildGitCloneCommand(url, branch, mountPath);
      expect(result).toContain('--branch "develop"');
    });

    it("should properly quote paths", () => {
      const url = "https://github.com/user/repo.git";
      const branch = "main";
      const mountPath = "/workspace/my repo";
      const result = buildGitCloneCommand(url, branch, mountPath);
      expect(result).toContain('"/workspace/my repo"');
    });
  });
});
