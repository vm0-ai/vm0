import { describe, it, expect } from "vitest";
import {
  validateAgentName,
  normalizeAgentName,
  validateAgentCompose,
  validateGitHubTreeUrl,
} from "../yaml-validator";

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

describe("normalizeAgentName", () => {
  it("should normalize valid name to lowercase", () => {
    expect(normalizeAgentName("My-Agent")).toBe("my-agent");
  });

  it("should normalize uppercase name to lowercase", () => {
    expect(normalizeAgentName("MY-AGENT")).toBe("my-agent");
  });

  it("should keep lowercase name unchanged", () => {
    expect(normalizeAgentName("my-agent")).toBe("my-agent");
  });

  it("should normalize mixed case with numbers", () => {
    expect(normalizeAgentName("My-Agent-123")).toBe("my-agent-123");
  });

  it("should return null for invalid name format", () => {
    expect(normalizeAgentName("ab")).toBeNull(); // too short
    expect(normalizeAgentName("-agent")).toBeNull(); // starts with hyphen
    expect(normalizeAgentName("agent-")).toBeNull(); // ends with hyphen
    expect(normalizeAgentName("my_agent")).toBeNull(); // invalid character
  });
});

describe("validateAgentCompose", () => {
  describe("valid configs", () => {
    it("should accept minimal valid config", () => {
      const config = {
        version: "1.0",
        agents: {
          "test-agent": {
            image: "vm0/claude-code:dev",
            framework: "claude-code",
            working_dir: "/home/user/workspace",
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should accept config with volumes", () => {
      const config = {
        version: "1.0",
        agents: {
          "test-agent": {
            description: "Test description",
            image: "vm0/claude-code:dev",
            framework: "claude-code",
            working_dir: "/home/user/workspace",
            volumes: ["claude-files:/home/user/.config/claude"],
          },
        },
        volumes: {
          "claude-files": {
            name: "claude-files",
            version: "latest",
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(true);
    });

    it("should accept config with complex name", () => {
      const config = {
        version: "1.0",
        agents: {
          "My-Test-Agent-123": {
            image: "vm0/claude-code:dev",
            framework: "claude-code",
            working_dir: "/home/user/workspace",
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(true);
    });
  });

  describe("invalid configs", () => {
    it("should reject null config", () => {
      const result = validateAgentCompose(null);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Config must be an object");
    });

    it("should reject undefined config", () => {
      const result = validateAgentCompose(undefined);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Config must be an object");
    });

    it("should reject non-object config", () => {
      const result = validateAgentCompose("invalid");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Config must be an object");
    });

    it("should reject config without version", () => {
      const config = {
        agents: {
          "test-agent": {
            image: "vm0/claude-code:dev",
            framework: "claude-code",
            working_dir: "/home/user/workspace",
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Missing config.version");
    });

    it("should reject config without agents section", () => {
      const config = {
        version: "1.0",
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Missing agents object in config");
    });

    it("should reject config with array agents (must be object)", () => {
      const config = {
        version: "1.0",
        agents: [{ name: "test" }],
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("agents must be an object, not an array");
    });

    it("should reject config with empty agents object", () => {
      const config = {
        version: "1.0",
        agents: {},
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("agents must have at least one agent defined");
    });

    it("should reject config with multiple agents", () => {
      const config = {
        version: "1.0",
        agents: {
          "agent-1": {
            image: "vm0/claude-code:dev",
            framework: "claude-code",
            working_dir: "/workspace",
          },
          "agent-2": {
            image: "vm0/claude-code:dev",
            framework: "claude-code",
            working_dir: "/workspace",
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        "Multiple agents not supported yet. Only one agent allowed.",
      );
    });

    it("should reject config with invalid agent name format (too short)", () => {
      const config = {
        version: "1.0",
        agents: {
          ab: {
            // Too short
            image: "vm0/claude-code:dev",
            framework: "claude-code",
            working_dir: "/home/user/workspace",
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid agent name format");
    });

    it("should reject config with agent name starting with hyphen", () => {
      const config = {
        version: "1.0",
        agents: {
          "-invalid": {
            image: "vm0/claude-code:dev",
            framework: "claude-code",
            working_dir: "/home/user/workspace",
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid agent name format");
    });

    it("should reject config with agent name containing special characters", () => {
      const config = {
        version: "1.0",
        agents: {
          my_agent: {
            image: "vm0/claude-code:dev",
            framework: "claude-code",
            working_dir: "/home/user/workspace",
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid agent name format");
    });

    it("should reject config with missing working_dir when framework not supported", () => {
      const config = {
        version: "1.0",
        agents: {
          "test-agent": {
            image: "custom-image",
            framework: "custom-framework",
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("agent.working_dir");
    });

    it("should reject config with missing image when framework not supported", () => {
      const config = {
        version: "1.0",
        agents: {
          "test-agent": {
            framework: "custom-framework",
            working_dir: "/home/user/workspace",
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("agent.image");
    });

    it("should reject config with missing framework", () => {
      const config = {
        version: "1.0",
        agents: {
          "test-agent": {
            image: "vm0/claude-code:dev",
            working_dir: "/home/user/workspace",
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("agent.framework");
    });

    it("should reject config with deprecated provider field and show migration message", () => {
      const config = {
        version: "1.0",
        agents: {
          "test-agent": {
            provider: "claude-code",
            image: "vm0/claude-code:dev",
            working_dir: "/home/user/workspace",
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("'provider' field is deprecated");
      expect(result.error).toContain("Use 'framework' instead");
      expect(result.error).toContain("- provider: claude-code");
      expect(result.error).toContain("+ framework: claude-code");
    });

    it("should reject config with volume reference missing from volumes section", () => {
      const config = {
        version: "1.0",
        agents: {
          "test-agent": {
            image: "vm0/claude-code:dev",
            framework: "claude-code",
            working_dir: "/home/user/workspace",
            volumes: ["missing-vol:/path"],
          },
        },
        volumes: {
          "other-vol": {
            name: "other-vol",
            version: "latest",
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("missing-vol");
    });

    it("should reject config with volume missing name field", () => {
      const config = {
        version: "1.0",
        agents: {
          "test-agent": {
            image: "vm0/claude-code:dev",
            framework: "claude-code",
            working_dir: "/home/user/workspace",
            volumes: ["data:/path"],
          },
        },
        volumes: {
          data: {
            version: "latest",
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("'name' field");
    });

    it("should reject config with volume missing version field", () => {
      const config = {
        version: "1.0",
        agents: {
          "test-agent": {
            image: "vm0/claude-code:dev",
            framework: "claude-code",
            working_dir: "/home/user/workspace",
            volumes: ["data:/path"],
          },
        },
        volumes: {
          data: {
            name: "my-data",
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("'version' field");
    });
  });

  describe("framework auto-config", () => {
    it("should accept config without working_dir when framework is claude-code", () => {
      const config = {
        version: "1.0",
        agents: {
          "test-agent": {
            framework: "claude-code",
            image: "vm0/claude-code:dev",
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(true);
    });

    it("should accept config without image when framework is claude-code (auto-configurable)", () => {
      const config = {
        version: "1.0",
        agents: {
          "test-agent": {
            framework: "claude-code",
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(true);
    });

    it("should accept config with instructions", () => {
      const config = {
        version: "1.0",
        agents: {
          "test-agent": {
            framework: "claude-code",
            image: "vm0/claude-code:dev",
            instructions: "AGENTS.md",
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(true);
    });

    it("should accept config with skills", () => {
      const config = {
        version: "1.0",
        agents: {
          "test-agent": {
            framework: "claude-code",
            image: "vm0/claude-code:dev",
            skills: ["https://github.com/vm0-ai/vm0-skills/tree/main/github"],
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(true);
    });

    it("should reject empty instructions", () => {
      const config = {
        version: "1.0",
        agents: {
          "test-agent": {
            framework: "claude-code",
            image: "vm0/claude-code:dev",
            instructions: "",
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("cannot be empty");
    });

    it("should reject invalid skill URL", () => {
      const config = {
        version: "1.0",
        agents: {
          "test-agent": {
            framework: "claude-code",
            image: "vm0/claude-code:dev",
            skills: ["https://example.com/not-github"],
          },
        },
      };

      const result = validateAgentCompose(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid skill URL");
    });
  });
});

describe("validateGitHubTreeUrl", () => {
  it("should accept valid GitHub tree URL", () => {
    expect(
      validateGitHubTreeUrl(
        "https://github.com/vm0-ai/vm0-skills/tree/main/github",
      ),
    ).toBe(true);
  });

  it("should accept URL with nested path", () => {
    expect(
      validateGitHubTreeUrl(
        "https://github.com/vm0-ai/vm0-skills/tree/main/skills/github-cli",
      ),
    ).toBe(true);
  });

  it("should accept URL with version branch", () => {
    expect(
      validateGitHubTreeUrl(
        "https://github.com/vm0-ai/vm0-skills/tree/v1.0/notion",
      ),
    ).toBe(true);
  });

  it("should reject non-GitHub URL", () => {
    expect(validateGitHubTreeUrl("https://example.com/foo/bar")).toBe(false);
  });

  it("should reject GitHub URL without tree path", () => {
    expect(validateGitHubTreeUrl("https://github.com/vm0-ai/vm0-skills")).toBe(
      false,
    );
  });

  it("should reject GitHub blob URL", () => {
    expect(
      validateGitHubTreeUrl(
        "https://github.com/vm0-ai/vm0-skills/blob/main/README.md",
      ),
    ).toBe(false);
  });
});
