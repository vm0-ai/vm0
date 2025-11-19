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
        agent: {
          name: "test-agent",
        },
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should accept config with additional fields", () => {
      const config = {
        version: "1.0",
        agent: {
          name: "test-agent",
          description: "Test description",
          instructions: "Do something",
        },
        tools: [],
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(true);
    });

    it("should accept config with complex name", () => {
      const config = {
        version: "1.0",
        agent: {
          name: "My-Test-Agent-123",
        },
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
        agent: {
          name: "test-agent",
        },
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Missing config.version");
    });

    it("should reject config without agent section", () => {
      const config = {
        version: "1.0",
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Missing config.agent");
    });

    it("should reject config with non-object agent", () => {
      const config = {
        version: "1.0",
        agent: "invalid",
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Missing config.agent");
    });

    it("should reject config without agent.name", () => {
      const config = {
        version: "1.0",
        agent: {},
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Missing agent.name");
    });

    it("should reject config with non-string agent.name", () => {
      const config = {
        version: "1.0",
        agent: {
          name: 123,
        },
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("agent.name must be a string");
    });

    it("should reject config with invalid agent.name format", () => {
      const config = {
        version: "1.0",
        agent: {
          name: "ab", // Too short
        },
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid agent.name format");
    });

    it("should reject config with agent.name starting with hyphen", () => {
      const config = {
        version: "1.0",
        agent: {
          name: "-invalid",
        },
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid agent.name format");
    });

    it("should reject config with agent.name containing special characters", () => {
      const config = {
        version: "1.0",
        agent: {
          name: "my_agent",
        },
      };

      const result = validateAgentConfig(config);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid agent.name format");
    });
  });
});
