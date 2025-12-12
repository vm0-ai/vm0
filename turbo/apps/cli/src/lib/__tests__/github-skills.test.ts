import { describe, it, expect } from "vitest";
import {
  parseGitHubTreeUrl,
  getSkillStorageName,
  getSystemPromptStorageName,
} from "../github-skills";

describe("parseGitHubTreeUrl", () => {
  describe("valid URLs", () => {
    it("should parse standard GitHub tree URL", () => {
      const url = "https://github.com/vm0-ai/vm0-skills/tree/main/github-cli";
      const result = parseGitHubTreeUrl(url);

      expect(result.owner).toBe("vm0-ai");
      expect(result.repo).toBe("vm0-skills");
      expect(result.branch).toBe("main");
      expect(result.path).toBe("github-cli");
      expect(result.skillName).toBe("github-cli");
    });

    it("should parse URL with nested path", () => {
      const url =
        "https://github.com/owner/repo/tree/develop/skills/programming/python";
      const result = parseGitHubTreeUrl(url);

      expect(result.owner).toBe("owner");
      expect(result.repo).toBe("repo");
      expect(result.branch).toBe("develop");
      expect(result.path).toBe("skills/programming/python");
      expect(result.skillName).toBe("python");
    });

    it("should parse URL with numbers and hyphens", () => {
      const url =
        "https://github.com/my-org-123/skill-repo-v2/tree/release-1.0/my-skill";
      const result = parseGitHubTreeUrl(url);

      expect(result.owner).toBe("my-org-123");
      expect(result.repo).toBe("skill-repo-v2");
      expect(result.branch).toBe("release-1.0");
      expect(result.path).toBe("my-skill");
      expect(result.skillName).toBe("my-skill");
    });

    it("should handle commit hash as branch", () => {
      const url = "https://github.com/owner/repo/tree/abc123def/path/to/skill";
      const result = parseGitHubTreeUrl(url);

      expect(result.branch).toBe("abc123def");
      expect(result.path).toBe("path/to/skill");
      expect(result.skillName).toBe("skill");
    });
  });

  describe("invalid URLs", () => {
    it("should throw for non-GitHub URL", () => {
      expect(() =>
        parseGitHubTreeUrl("https://gitlab.com/owner/repo/tree/main/skill"),
      ).toThrow("Invalid GitHub tree URL");
    });

    it("should throw for URL without tree", () => {
      expect(() =>
        parseGitHubTreeUrl("https://github.com/owner/repo/blob/main/file.md"),
      ).toThrow("Invalid GitHub tree URL");
    });

    it("should throw for URL without path after branch", () => {
      expect(() =>
        parseGitHubTreeUrl("https://github.com/owner/repo/tree/main"),
      ).toThrow("Invalid GitHub tree URL");
    });

    it("should throw for empty string", () => {
      expect(() => parseGitHubTreeUrl("")).toThrow("Invalid GitHub tree URL");
    });

    it("should throw for repository root URL", () => {
      expect(() => parseGitHubTreeUrl("https://github.com/owner/repo")).toThrow(
        "Invalid GitHub tree URL",
      );
    });
  });
});

describe("getSkillStorageName", () => {
  it("should generate correct storage name", () => {
    const parsed = {
      owner: "vm0-ai",
      repo: "vm0-skills",
      branch: "main",
      path: "github-cli",
      skillName: "github-cli",
    };

    expect(getSkillStorageName(parsed)).toBe(
      "__system-skill-vm0-ai/vm0-skills/main/github-cli__",
    );
  });

  it("should handle nested paths", () => {
    const parsed = {
      owner: "owner",
      repo: "repo",
      branch: "develop",
      path: "skills/programming/python",
      skillName: "python",
    };

    expect(getSkillStorageName(parsed)).toBe(
      "__system-skill-owner/repo/develop/skills/programming/python__",
    );
  });
});

describe("getSystemPromptStorageName", () => {
  it("should generate correct storage name", () => {
    expect(getSystemPromptStorageName("my-agent")).toBe(
      "__system-prompt-my-agent__",
    );
  });

  it("should handle complex agent names", () => {
    expect(getSystemPromptStorageName("My-Test-Agent-123")).toBe(
      "__system-prompt-My-Test-Agent-123__",
    );
  });
});
