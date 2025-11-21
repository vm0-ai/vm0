import { describe, it, expect } from "vitest";
import { parseGitHubUri } from "../github-client";

describe("github-client", () => {
  describe("parseGitHubUri", () => {
    it("should parse URI with owner, repo, and ref", () => {
      const result = parseGitHubUri("github://owner/repo@main");

      expect(result).toEqual({
        owner: "owner",
        repo: "repo",
        path: "",
        ref: "main",
      });
    });

    it("should parse URI with owner and repo only", () => {
      const result = parseGitHubUri("github://owner/repo");

      expect(result).toEqual({
        owner: "owner",
        repo: "repo",
        path: "",
        ref: "main",
      });
    });

    it("should parse URI with path", () => {
      const result = parseGitHubUri("github://owner/repo/path/to/dir@branch");

      expect(result).toEqual({
        owner: "owner",
        repo: "repo",
        path: "path/to/dir",
        ref: "branch",
      });
    });

    it("should parse URI with commit SHA", () => {
      const result = parseGitHubUri(
        "github://owner/repo@abc123def456789012345678901234567890abcd",
      );

      expect(result).toEqual({
        owner: "owner",
        repo: "repo",
        path: "",
        ref: "abc123def456789012345678901234567890abcd",
      });
    });

    it("should throw on invalid URI", () => {
      expect(() => parseGitHubUri("invalid-uri")).toThrow("Invalid GitHub URI");

      expect(() => parseGitHubUri("https://github.com/owner/repo")).toThrow(
        "Invalid GitHub URI",
      );

      expect(() => parseGitHubUri("github://owner")).toThrow(
        "Invalid GitHub URI",
      );
    });
  });
});
