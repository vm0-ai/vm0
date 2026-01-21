import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractVariableReferences,
  deriveAgentVariableSources,
  deriveComposeVariableSources,
} from "../source-derivation";

// Mock the github-skills module
vi.mock("../github-skills", () => ({
  parseGitHubTreeUrl: vi.fn((url: string) => {
    // Extract skill name from URL for testing
    const parts = url.split("/");
    const skillName = parts[parts.length - 1];
    return {
      owner: "test-owner",
      repo: "test-repo",
      branch: "main",
      path: skillName,
      skillName,
      fullPath: `test-owner/test-repo/tree/main/${skillName}`,
    };
  }),
  downloadGitHubSkill: vi.fn(),
  readSkillFrontmatter: vi.fn(),
}));

// Import mocked functions for setup
import { downloadGitHubSkill, readSkillFrontmatter } from "../github-skills";

const mockDownloadGitHubSkill = vi.mocked(downloadGitHubSkill);
const mockReadSkillFrontmatter = vi.mocked(readSkillFrontmatter);

describe("source-derivation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("extractVariableReferences", () => {
    it("should extract variables with ${VAR} syntax", () => {
      const env = {
        FOO: "${MY_VAR}",
        BAR: "${ANOTHER_VAR}",
      };
      const result = extractVariableReferences(env);

      expect(result.vars).toContain("MY_VAR");
      expect(result.vars).toContain("ANOTHER_VAR");
      expect(result.secrets).toHaveLength(0);
    });

    it("should extract variables with $VAR syntax", () => {
      const env = {
        FOO: "$MY_VAR",
        BAR: "$ANOTHER_VAR",
      };
      const result = extractVariableReferences(env);

      expect(result.vars).toContain("MY_VAR");
      expect(result.vars).toContain("ANOTHER_VAR");
    });

    it("should classify _KEY suffix as secret", () => {
      const env = {
        API: "${MY_API_KEY}",
      };
      const result = extractVariableReferences(env);

      expect(result.secrets).toContain("MY_API_KEY");
      expect(result.vars).not.toContain("MY_API_KEY");
    });

    it("should classify _SECRET suffix as secret", () => {
      const env = {
        AUTH: "${AUTH_SECRET}",
      };
      const result = extractVariableReferences(env);

      expect(result.secrets).toContain("AUTH_SECRET");
    });

    it("should classify _TOKEN suffix as secret", () => {
      const env = {
        AUTH: "${ACCESS_TOKEN}",
      };
      const result = extractVariableReferences(env);

      expect(result.secrets).toContain("ACCESS_TOKEN");
    });

    it("should classify _PASSWORD suffix as secret", () => {
      const env = {
        DB: "${DB_PASSWORD}",
      };
      const result = extractVariableReferences(env);

      expect(result.secrets).toContain("DB_PASSWORD");
    });

    it("should classify API_KEY containing names as secret", () => {
      const env = {
        OPENAI: "${OPENAI_API_KEY}",
      };
      const result = extractVariableReferences(env);

      expect(result.secrets).toContain("OPENAI_API_KEY");
    });

    it("should classify SECRET containing names as secret", () => {
      const env = {
        AWS: "${AWS_SECRET_ACCESS_KEY}",
      };
      const result = extractVariableReferences(env);

      expect(result.secrets).toContain("AWS_SECRET_ACCESS_KEY");
    });

    it("should handle multiple variables in one value", () => {
      const env = {
        CONNECTION: "${HOST}:${PORT}/${DATABASE}",
      };
      const result = extractVariableReferences(env);

      expect(result.vars).toEqual(["DATABASE", "HOST", "PORT"]);
    });

    it("should deduplicate variables", () => {
      const env = {
        FOO: "${MY_VAR}",
        BAR: "${MY_VAR}",
        BAZ: "${MY_VAR}",
      };
      const result = extractVariableReferences(env);

      expect(result.vars).toEqual(["MY_VAR"]);
    });

    it("should return sorted results", () => {
      const env = {
        A: "${ZEBRA}",
        B: "${APPLE}",
        C: "${MANGO}",
      };
      const result = extractVariableReferences(env);

      expect(result.vars).toEqual(["APPLE", "MANGO", "ZEBRA"]);
    });

    it("should return empty arrays for empty environment", () => {
      const result = extractVariableReferences({});

      expect(result.secrets).toEqual([]);
      expect(result.vars).toEqual([]);
    });

    it("should ignore values without variable references", () => {
      const env = {
        STATIC: "just-a-string",
        NUMBER: "12345",
      };
      const result = extractVariableReferences(env);

      expect(result.secrets).toEqual([]);
      expect(result.vars).toEqual([]);
    });

    it("should handle mixed secrets and vars", () => {
      const env = {
        API: "${API_KEY}",
        HOST: "${SERVER_HOST}",
        TOKEN: "${AUTH_TOKEN}",
        PORT: "${SERVER_PORT}",
      };
      const result = extractVariableReferences(env);

      expect(result.secrets).toEqual(["API_KEY", "AUTH_TOKEN"]);
      expect(result.vars).toEqual(["SERVER_HOST", "SERVER_PORT"]);
    });
  });

  describe("deriveAgentVariableSources", () => {
    it("should return empty sources for agent without environment", async () => {
      const agent = {
        framework: "claude-code",
      };

      const result = await deriveAgentVariableSources(agent);

      expect(result.secrets).toEqual([]);
      expect(result.vars).toEqual([]);
    });

    it("should return agent environment as source when no skills", async () => {
      const agent = {
        framework: "claude-code",
        environment: {
          API: "${API_KEY}",
          HOST: "${SERVER_HOST}",
        },
      };

      const result = await deriveAgentVariableSources(agent);

      expect(result.secrets).toEqual([
        { name: "API_KEY", source: "agent environment" },
      ]);
      expect(result.vars).toEqual([
        { name: "SERVER_HOST", source: "agent environment" },
      ]);
    });

    it("should return agent environment as source when skipNetwork is true", async () => {
      const agent = {
        framework: "claude-code",
        environment: {
          API: "${API_KEY}",
        },
        skills: ["https://github.com/test/skills/tree/main/my-skill"],
      };

      const result = await deriveAgentVariableSources(agent, {
        skipNetwork: true,
      });

      expect(result.secrets).toEqual([
        { name: "API_KEY", source: "agent environment" },
      ]);
      // downloadGitHubSkill should not be called
      expect(mockDownloadGitHubSkill).not.toHaveBeenCalled();
    });

    it("should attribute secrets to skill when skill declares them", async () => {
      const agent = {
        framework: "claude-code",
        environment: {
          API: "${OPENAI_API_KEY}",
          HOST: "${SERVER_HOST}",
        },
        skills: ["https://github.com/test/skills/tree/main/openai-skill"],
      };

      mockDownloadGitHubSkill.mockResolvedValue("/tmp/openai-skill");
      mockReadSkillFrontmatter.mockResolvedValue({
        name: "OpenAI Skill",
        vm0_secrets: ["OPENAI_API_KEY"],
      });

      const result = await deriveAgentVariableSources(agent);

      expect(result.secrets).toEqual([
        {
          name: "OPENAI_API_KEY",
          source: "skill: openai-skill",
          skillName: "openai-skill",
        },
      ]);
      expect(result.vars).toEqual([
        { name: "SERVER_HOST", source: "agent environment" },
      ]);
    });

    it("should attribute vars to skill when skill declares them", async () => {
      const agent = {
        framework: "claude-code",
        environment: {
          MODEL: "${OPENAI_MODEL}",
          HOST: "${SERVER_HOST}",
        },
        skills: ["https://github.com/test/skills/tree/main/openai-skill"],
      };

      mockDownloadGitHubSkill.mockResolvedValue("/tmp/openai-skill");
      mockReadSkillFrontmatter.mockResolvedValue({
        name: "OpenAI Skill",
        vm0_vars: ["OPENAI_MODEL"],
      });

      const result = await deriveAgentVariableSources(agent);

      expect(result.vars).toContainEqual({
        name: "OPENAI_MODEL",
        source: "skill: openai-skill",
        skillName: "openai-skill",
      });
      expect(result.vars).toContainEqual({
        name: "SERVER_HOST",
        source: "agent environment",
      });
    });

    it("should handle skill download failure gracefully", async () => {
      const agent = {
        framework: "claude-code",
        environment: {
          API: "${API_KEY}",
        },
        skills: ["https://github.com/test/skills/tree/main/broken-skill"],
      };

      mockDownloadGitHubSkill.mockRejectedValue(new Error("Download failed"));

      const result = await deriveAgentVariableSources(agent);

      // Should fall back to agent environment
      expect(result.secrets).toEqual([
        { name: "API_KEY", source: "agent environment" },
      ]);
    });

    it("should handle multiple skills", async () => {
      const agent = {
        framework: "claude-code",
        environment: {
          API: "${OPENAI_API_KEY}",
          GH: "${GITHUB_TOKEN}",
          HOST: "${SERVER_HOST}",
        },
        skills: [
          "https://github.com/test/skills/tree/main/openai-skill",
          "https://github.com/test/skills/tree/main/github-skill",
        ],
      };

      mockDownloadGitHubSkill
        .mockResolvedValueOnce("/tmp/openai-skill")
        .mockResolvedValueOnce("/tmp/github-skill");

      mockReadSkillFrontmatter
        .mockResolvedValueOnce({
          name: "OpenAI Skill",
          vm0_secrets: ["OPENAI_API_KEY"],
        })
        .mockResolvedValueOnce({
          name: "GitHub Skill",
          vm0_secrets: ["GITHUB_TOKEN"],
        });

      const result = await deriveAgentVariableSources(agent);

      expect(result.secrets).toContainEqual({
        name: "OPENAI_API_KEY",
        source: "skill: openai-skill",
        skillName: "openai-skill",
      });
      expect(result.secrets).toContainEqual({
        name: "GITHUB_TOKEN",
        source: "skill: github-skill",
        skillName: "github-skill",
      });
      expect(result.vars).toEqual([
        { name: "SERVER_HOST", source: "agent environment" },
      ]);
    });
  });

  describe("deriveComposeVariableSources", () => {
    it("should derive sources for all agents in compose", async () => {
      const content = {
        version: "1.0",
        agents: {
          "main-agent": {
            framework: "claude-code",
            environment: {
              API: "${API_KEY}",
            },
          },
          "worker-agent": {
            framework: "claude-code",
            environment: {
              HOST: "${SERVER_HOST}",
            },
          },
        },
      };

      const result = await deriveComposeVariableSources(content, {
        skipNetwork: true,
      });

      expect(result.size).toBe(2);

      const mainSources = result.get("main-agent");
      expect(mainSources?.secrets).toEqual([
        { name: "API_KEY", source: "agent environment" },
      ]);

      const workerSources = result.get("worker-agent");
      expect(workerSources?.vars).toEqual([
        { name: "SERVER_HOST", source: "agent environment" },
      ]);
    });

    it("should handle compose with single agent", async () => {
      const content = {
        version: "1.0",
        agents: {
          solo: {
            framework: "claude-code",
            environment: {
              TOKEN: "${AUTH_TOKEN}",
            },
          },
        },
      };

      const result = await deriveComposeVariableSources(content, {
        skipNetwork: true,
      });

      expect(result.size).toBe(1);
      expect(result.get("solo")?.secrets).toEqual([
        { name: "AUTH_TOKEN", source: "agent environment" },
      ]);
    });

    it("should handle compose with agents without environment", async () => {
      const content = {
        version: "1.0",
        agents: {
          simple: {
            framework: "claude-code",
          },
        },
      };

      const result = await deriveComposeVariableSources(content, {
        skipNetwork: true,
      });

      expect(result.size).toBe(1);
      const sources = result.get("simple");
      expect(sources?.secrets).toEqual([]);
      expect(sources?.vars).toEqual([]);
    });
  });
});
