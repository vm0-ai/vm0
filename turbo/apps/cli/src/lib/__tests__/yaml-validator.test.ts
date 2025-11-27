import { describe, it, expect } from "vitest";
import { validateAgentName, validateAgentConfig } from "../yaml-validator";

describe("validateAgentName", () => {
  describe("valid names", () => {
    it("should accept simple lowercase name", () => {
      expect(validateAgentName("my-agent")).toBe(true);
    });

    it("should accept name with uppercase letters", () => {
      expect(validateAgentName("My-Agent")).toBe(true);
    });

    it("should accept name with numbers", () => {
      expect(validateAgentName("agent-123")).toBe(true);
    });

    it("should accept minimum length (3 chars)", () => {
      expect(validateAgentName("abc")).toBe(true);
    });

    it("should accept maximum length (64 chars)", () => {
      const name = "a".repeat(64);
      expect(validateAgentName(name)).toBe(true);
    });

    it("should accept name starting with number", () => {
      expect(validateAgentName("1-agent")).toBe(true);
    });

    it("should accept name ending with number", () => {
      expect(validateAgentName("agent-1")).toBe(true);
    });

    it("should accept name with multiple hyphens", () => {
      expect(validateAgentName("my-test-agent")).toBe(true);
    });
  });

  describe("invalid names", () => {
    it("should reject name too short (< 3 chars)", () => {
      expect(validateAgentName("ab")).toBe(false);
    });

    it("should reject name too long (> 64 chars)", () => {
      const name = "a".repeat(65);
      expect(validateAgentName(name)).toBe(false);
    });

    it("should reject name starting with hyphen", () => {
      expect(validateAgentName("-agent")).toBe(false);
    });

    it("should reject name ending with hyphen", () => {
      expect(validateAgentName("agent-")).toBe(false);
    });

    it("should reject name with special characters", () => {
      expect(validateAgentName("my_agent")).toBe(false);
      expect(validateAgentName("my.agent")).toBe(false);
      expect(validateAgentName("my@agent")).toBe(false);
      expect(validateAgentName("my agent")).toBe(false);
    });

    it("should reject empty string", () => {
      expect(validateAgentName("")).toBe(false);
    });

    it("should reject name with only hyphen", () => {
      expect(validateAgentName("-")).toBe(false);
    });
  });
});

describe("validateAgentConfig", () => {
  describe("valid configs", () => {
    it("should accept minimal valid config", () => {
      const config = {
        version: "1.0",
        agents: [
          {
            name: "test-agent",
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
          },
        ],
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should accept config with volumes", () => {
      const config = {
        version: "1.0",
        agents: [
          {
            name: "test-agent",
            description: "Test description",
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
            volumes: ["claude-files:/home/user/.config/claude"],
          },
        ],
        volumes: {
          "claude-files": {
            name: "claude-files",
            version: "latest",
          },
        },
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(true);
    });

    it("should accept config with complex name", () => {
      const config = {
        version: "1.0",
        agents: [
          {
            name: "My-Test-Agent-123",
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
          },
        ],
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(true);
    });
  });

  describe("invalid configs", () => {
    it("should reject null config", () => {
      const result = validateAgentConfig(null);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Config must be an object");
    });

    it("should reject undefined config", () => {
      const result = validateAgentConfig(undefined);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Config must be an object");
    });

    it("should reject non-object config", () => {
      const result = validateAgentConfig("invalid");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Config must be an object");
    });

    it("should reject config without version", () => {
      const config = {
        agents: [
          {
            name: "test-agent",
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
          },
        ],
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Missing config.version");
    });

    it("should reject config without agents section", () => {
      const config = {
        version: "1.0",
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Missing config.agents array");
    });

    it("should reject config with non-array agents", () => {
      const config = {
        version: "1.0",
        agents: "invalid",
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Missing config.agents array");
    });

    it("should reject config with empty agents array", () => {
      const config = {
        version: "1.0",
        agents: [],
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("config.agents array must not be empty");
    });

    it("should reject config without agents[0].name", () => {
      const config = {
        version: "1.0",
        agents: [
          {
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
          },
        ],
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Missing agents[0].name");
    });

    it("should reject config with non-string agents[0].name", () => {
      const config = {
        version: "1.0",
        agents: [
          {
            name: 123,
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
          },
        ],
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("agents[0].name must be a string");
    });

    it("should reject config with invalid agents[0].name format", () => {
      const config = {
        version: "1.0",
        agents: [
          {
            name: "ab", // Too short
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
          },
        ],
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid agents[0].name format");
    });

    it("should reject config with agents[0].name starting with hyphen", () => {
      const config = {
        version: "1.0",
        agents: [
          {
            name: "-invalid",
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
          },
        ],
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid agents[0].name format");
    });

    it("should reject config with agents[0].name containing special characters", () => {
      const config = {
        version: "1.0",
        agents: [
          {
            name: "my_agent",
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
          },
        ],
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid agents[0].name format");
    });

    it("should reject config with missing working_dir", () => {
      const config = {
        version: "1.0",
        agents: [
          {
            name: "test-agent",
            image: "vm0-claude-code-dev",
            provider: "claude-code",
          },
        ],
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("agents[0].working_dir");
    });

    it("should reject config with missing image", () => {
      const config = {
        version: "1.0",
        agents: [
          {
            name: "test-agent",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
          },
        ],
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("agents[0].image");
    });

    it("should reject config with missing provider", () => {
      const config = {
        version: "1.0",
        agents: [
          {
            name: "test-agent",
            image: "vm0-claude-code-dev",
            working_dir: "/home/user/workspace",
          },
        ],
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("agents[0].provider");
    });

    it("should reject config with volume reference missing from volumes section", () => {
      const config = {
        version: "1.0",
        agents: [
          {
            name: "test-agent",
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
            volumes: ["missing-vol:/path"],
          },
        ],
        volumes: {
          "other-vol": {
            name: "other-vol",
            version: "latest",
          },
        },
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("missing-vol");
    });

    it("should reject config with volume missing name field", () => {
      const config = {
        version: "1.0",
        agents: [
          {
            name: "test-agent",
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
            volumes: ["data:/path"],
          },
        ],
        volumes: {
          data: {
            version: "latest",
          },
        },
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("'name' field");
    });

    it("should reject config with volume missing version field", () => {
      const config = {
        version: "1.0",
        agents: [
          {
            name: "test-agent",
            image: "vm0-claude-code-dev",
            provider: "claude-code",
            working_dir: "/home/user/workspace",
            volumes: ["data:/path"],
          },
        ],
        volumes: {
          data: {
            name: "my-data",
          },
        },
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("'version' field");
    });
  });
});
