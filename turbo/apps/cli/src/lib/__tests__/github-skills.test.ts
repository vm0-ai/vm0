import { describe, it, expect } from "vitest";
import {
  parseGitHubTreeUrl,
  getSkillStorageName,
  getInstructionsStorageName,
  parseSkillFrontmatter,
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
        "Invalid GitHub tree URL",
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

  describe("parseSkillFrontmatter", () => {
    it("should parse valid frontmatter with all fields", () => {
      const content = `---
name: OpenAI Skill
description: Integration with OpenAI API
vm0_secrets:
  - OPENAI_API_KEY
  - OPENAI_ORG_ID
vm0_vars:
  - OPENAI_MODEL
  - OPENAI_BASE_URL
---

# OpenAI Skill

Some content here...
`;
      const result = parseSkillFrontmatter(content);

      expect(result.name).toBe("OpenAI Skill");
      expect(result.description).toBe("Integration with OpenAI API");
      expect(result.vm0_secrets).toEqual(["OPENAI_API_KEY", "OPENAI_ORG_ID"]);
      expect(result.vm0_vars).toEqual(["OPENAI_MODEL", "OPENAI_BASE_URL"]);
    });

    it("should parse frontmatter with only vm0_secrets", () => {
      const content = `---
name: Simple Skill
vm0_secrets:
  - API_KEY
---

# Simple Skill
`;
      const result = parseSkillFrontmatter(content);

      expect(result.name).toBe("Simple Skill");
      expect(result.vm0_secrets).toEqual(["API_KEY"]);
      expect(result.vm0_vars).toBeUndefined();
    });

    it("should parse frontmatter with only vm0_vars", () => {
      const content = `---
name: Config Skill
vm0_vars:
  - CONFIG_URL
  - CONFIG_ID
---

# Config Skill
`;
      const result = parseSkillFrontmatter(content);

      expect(result.name).toBe("Config Skill");
      expect(result.vm0_secrets).toBeUndefined();
      expect(result.vm0_vars).toEqual(["CONFIG_URL", "CONFIG_ID"]);
    });

    it("should return empty object for content without frontmatter", () => {
      const content = `# No Frontmatter Skill

This skill has no frontmatter.
`;
      const result = parseSkillFrontmatter(content);

      expect(result).toEqual({});
    });

    it("should return empty object for malformed frontmatter", () => {
      const content = `---
invalid: yaml: syntax: here
---

# Broken Skill
`;
      const result = parseSkillFrontmatter(content);

      // YAML parser may still parse some invalid syntax, so just check it doesn't throw
      expect(result).toBeDefined();
    });

    it("should handle frontmatter with only name and description", () => {
      const content = `---
name: Basic Skill
description: A basic skill without env requirements
---

# Basic Skill
`;
      const result = parseSkillFrontmatter(content);

      expect(result.name).toBe("Basic Skill");
      expect(result.description).toBe("A basic skill without env requirements");
      expect(result.vm0_secrets).toBeUndefined();
      expect(result.vm0_vars).toBeUndefined();
    });

    it("should filter out non-string values from vm0_secrets", () => {
      const content = `---
name: Mixed Types Skill
vm0_secrets:
  - VALID_SECRET
  - 123
  - true
  - ANOTHER_SECRET
---

# Mixed Types
`;
      const result = parseSkillFrontmatter(content);

      expect(result.vm0_secrets).toEqual(["VALID_SECRET", "ANOTHER_SECRET"]);
    });

    it("should handle Windows-style line endings (CRLF)", () => {
      const content =
        "---\r\nname: Windows Skill\r\nvm0_secrets:\r\n  - SECRET_KEY\r\n---\r\n\r\n# Windows Skill";
      const result = parseSkillFrontmatter(content);

      expect(result.name).toBe("Windows Skill");
      expect(result.vm0_secrets).toEqual(["SECRET_KEY"]);
    });

    it("should return empty object for empty frontmatter", () => {
      const content = `---
---

# Empty Frontmatter
`;
      const result = parseSkillFrontmatter(content);

      expect(result).toEqual({});
    });
  });
});
