import { describe, it, expect } from "vitest";
import {
  parseGitHubTreeUrl,
  getSkillStorageName,
  getInstructionsStorageName,
} from "../github-skills";

describe("github-skills", () => {
  describe("parseGitHubTreeUrl", () => {
    it("should parse a valid GitHub tree URL", () => {
      const url = "https://github.com/vm0-ai/vm0-skills/tree/main/github";
      const result = parseGitHubTreeUrl(url);

      expect(result.owner).toBe("vm0-ai");
      expect(result.repo).toBe("vm0-skills");
      expect(result.branch).toBe("main");
      expect(result.path).toBe("github");
      expect(result.skillName).toBe("github");
      expect(result.fullPath).toBe("vm0-ai/vm0-skills/tree/main/github");
    });

    it("should parse URL with nested path", () => {
      const url =
        "https://github.com/vm0-ai/vm0-skills/tree/main/skills/github-cli";
      const result = parseGitHubTreeUrl(url);

      expect(result.owner).toBe("vm0-ai");
      expect(result.repo).toBe("vm0-skills");
      expect(result.branch).toBe("main");
      expect(result.path).toBe("skills/github-cli");
      expect(result.skillName).toBe("github-cli");
      expect(result.fullPath).toBe(
        "vm0-ai/vm0-skills/tree/main/skills/github-cli",
      );
    });

    it("should parse URL with version branch", () => {
      const url = "https://github.com/vm0-ai/vm0-skills/tree/v1.0/notion";
      const result = parseGitHubTreeUrl(url);

      expect(result.owner).toBe("vm0-ai");
      expect(result.repo).toBe("vm0-skills");
      expect(result.branch).toBe("v1.0");
      expect(result.path).toBe("notion");
      expect(result.skillName).toBe("notion");
    });

    it("should throw error for invalid URL format", () => {
      expect(() => parseGitHubTreeUrl("https://example.com/foo")).toThrow(
        "Invalid GitHub URL",
      );
    });

    it("should throw error for GitHub URL without tree path", () => {
      expect(() =>
        parseGitHubTreeUrl("https://github.com/vm0-ai/vm0-skills"),
      ).toThrow("Invalid GitHub tree URL");
    });

    it("should throw error for GitHub blob URL", () => {
      expect(() =>
        parseGitHubTreeUrl(
          "https://github.com/vm0-ai/vm0-skills/blob/main/README.md",
        ),
      ).toThrow("Invalid GitHub tree URL");
    });
  });

  describe("getSkillStorageName", () => {
    it("should generate storage name with @ format", () => {
      const parsed = parseGitHubTreeUrl(
        "https://github.com/vm0-ai/vm0-skills/tree/main/github",
      );
      const name = getSkillStorageName(parsed);

      expect(name).toBe("agent-skills@vm0-ai/vm0-skills/tree/main/github");
    });

    it("should include full path for nested skills", () => {
      const parsed = parseGitHubTreeUrl(
        "https://github.com/vm0-ai/vm0-skills/tree/v1.0/skills/notion",
      );
      const name = getSkillStorageName(parsed);

      expect(name).toBe(
        "agent-skills@vm0-ai/vm0-skills/tree/v1.0/skills/notion",
      );
    });
  });

  describe("getInstructionsStorageName", () => {
    it("should generate storage name with @ format", () => {
      const name = getInstructionsStorageName("my-agent");
      expect(name).toBe("agent-instructions@my-agent");
    });

    it("should handle agent names with hyphens", () => {
      const name = getInstructionsStorageName("my-cool-agent-v2");
      expect(name).toBe("agent-instructions@my-cool-agent-v2");
    });
  });
});
