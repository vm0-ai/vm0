import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildCommand } from "../build";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import * as yaml from "yaml";
import { apiClient } from "../../lib/api-client";
import * as yamlValidator from "../../lib/yaml-validator";

// Mock dependencies
vi.mock("fs/promises");
vi.mock("fs");
vi.mock("yaml");
vi.mock("../../lib/api-client");
vi.mock("../../lib/yaml-validator");

describe("build command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("file validation", () => {
    it("should exit with error if file does not exist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      await expect(async () => {
        await buildCommand.parseAsync(["node", "cli", "nonexistent.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Config file not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should read file when it exists", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue("version: 1.0");
      vi.mocked(yaml.parse).mockReturnValue({ version: "1.0" });
      vi.mocked(yamlValidator.validateAgentConfig).mockReturnValue({
        valid: true,
      });
      vi.mocked(apiClient.createOrUpdateConfig).mockResolvedValue({
        configId: "cfg-123",
        name: "test",
        action: "created",
      });

      await buildCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(fs.readFile).toHaveBeenCalledWith("config.yaml", "utf8");
    });
  });

  describe("YAML parsing", () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue("yaml content");
    });

    it("should exit with error on invalid YAML", async () => {
      vi.mocked(yaml.parse).mockImplementation(() => {
        throw new Error("Invalid YAML");
      });

      await expect(async () => {
        await buildCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid YAML format"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should parse valid YAML", async () => {
      const mockConfig = { version: "1.0", agent: { name: "test" } };
      vi.mocked(yaml.parse).mockReturnValue(mockConfig);
      vi.mocked(yamlValidator.validateAgentConfig).mockReturnValue({
        valid: true,
      });
      vi.mocked(apiClient.createOrUpdateConfig).mockResolvedValue({
        configId: "cfg-123",
        name: "test",
        action: "created",
      });

      await buildCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(yaml.parse).toHaveBeenCalled();
      expect(yamlValidator.validateAgentConfig).toHaveBeenCalledWith(
        mockConfig,
      );
    });
  });

  describe("environment variable validation", () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue("yaml content");
      // Clear env vars for testing
      delete process.env.ACCESS_TOKEN;
      delete process.env.API_KEY;
      delete process.env.DATABASE_URL;
    });

    it("should exit with error when single env var is missing", async () => {
      const configWithMissingVar = {
        version: "1.0",
        agent: { name: "test" },
        token: "${ACCESS_TOKEN}",
      };
      vi.mocked(yaml.parse).mockReturnValue(configWithMissingVar);

      await expect(async () => {
        await buildCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Missing required environment variables"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("ACCESS_TOKEN"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("export ACCESS_TOKEN=your-value"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error when multiple env vars are missing", async () => {
      const configWithMissingVars = {
        version: "1.0",
        agent: { name: "test" },
        token: "${ACCESS_TOKEN}",
        apiKey: "${API_KEY}",
        database: "${DATABASE_URL}",
      };
      vi.mocked(yaml.parse).mockReturnValue(configWithMissingVars);

      await expect(async () => {
        await buildCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Missing required environment variables"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("ACCESS_TOKEN"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("API_KEY"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("DATABASE_URL"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error when env var in nested object is missing", async () => {
      const configWithNestedVar = {
        version: "1.0",
        agent: { name: "test" },
        database: {
          connection: {
            url: "${DATABASE_URL}",
          },
        },
      };
      vi.mocked(yaml.parse).mockReturnValue(configWithNestedVar);

      await expect(async () => {
        await buildCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("DATABASE_URL"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error when env var in array is missing", async () => {
      const configWithArrayVar = {
        version: "1.0",
        agent: { name: "test" },
        tokens: ["${ACCESS_TOKEN}", "${API_KEY}"],
      };
      vi.mocked(yaml.parse).mockReturnValue(configWithArrayVar);

      await expect(async () => {
        await buildCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("ACCESS_TOKEN"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("API_KEY"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should proceed when all env vars are defined", async () => {
      process.env.ACCESS_TOKEN = "test-token";
      process.env.API_KEY = "test-key";

      const configWithVars = {
        version: "1.0",
        agent: { name: "test" },
        token: "${ACCESS_TOKEN}",
        apiKey: "${API_KEY}",
      };
      vi.mocked(yaml.parse).mockReturnValue(configWithVars);
      vi.mocked(yamlValidator.validateAgentConfig).mockReturnValue({
        valid: true,
      });
      vi.mocked(apiClient.createOrUpdateConfig).mockResolvedValue({
        configId: "cfg-123",
        name: "test",
        action: "created",
      });

      await buildCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(apiClient.createOrUpdateConfig).toHaveBeenCalled();
      expect(mockExit).not.toHaveBeenCalled();
    });

    it("should proceed when config has no env vars", async () => {
      const configWithoutVars = {
        version: "1.0",
        agent: { name: "test" },
        token: "plain-text-token",
      };
      vi.mocked(yaml.parse).mockReturnValue(configWithoutVars);
      vi.mocked(yamlValidator.validateAgentConfig).mockReturnValue({
        valid: true,
      });
      vi.mocked(apiClient.createOrUpdateConfig).mockResolvedValue({
        configId: "cfg-123",
        name: "test",
        action: "created",
      });

      await buildCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(apiClient.createOrUpdateConfig).toHaveBeenCalled();
      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe("config validation", () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue("yaml content");
      vi.mocked(yaml.parse).mockReturnValue({});
    });

    it("should exit with error on invalid config", async () => {
      vi.mocked(yamlValidator.validateAgentConfig).mockReturnValue({
        valid: false,
        error: "Missing agent.name",
      });

      await expect(async () => {
        await buildCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Missing agent.name"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should proceed with valid config", async () => {
      vi.mocked(yamlValidator.validateAgentConfig).mockReturnValue({
        valid: true,
      });
      vi.mocked(apiClient.createOrUpdateConfig).mockResolvedValue({
        configId: "cfg-123",
        name: "test",
        action: "created",
      });

      await buildCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(apiClient.createOrUpdateConfig).toHaveBeenCalled();
    });
  });

  describe("API interaction", () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue("yaml content");
      vi.mocked(yaml.parse).mockReturnValue({
        version: "1.0",
        agent: { name: "test" },
      });
      vi.mocked(yamlValidator.validateAgentConfig).mockReturnValue({
        valid: true,
      });
    });

    it("should display loading message", async () => {
      vi.mocked(apiClient.createOrUpdateConfig).mockResolvedValue({
        configId: "cfg-123",
        name: "test",
        action: "created",
      });

      await buildCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Uploading configuration"),
      );
    });

    it("should display created message", async () => {
      vi.mocked(apiClient.createOrUpdateConfig).mockResolvedValue({
        configId: "cfg-123",
        name: "test-agent",
        action: "created",
      });

      await buildCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Config created: test-agent"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Config ID: cfg-123"),
      );
    });

    it("should display updated message", async () => {
      vi.mocked(apiClient.createOrUpdateConfig).mockResolvedValue({
        configId: "cfg-123",
        name: "test-agent",
        action: "updated",
      });

      await buildCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Config updated: test-agent"),
      );
    });

    it("should display usage instructions", async () => {
      vi.mocked(apiClient.createOrUpdateConfig).mockResolvedValue({
        configId: "cfg-123",
        name: "test",
        action: "created",
      });

      await buildCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0 run test"),
      );
    });
  });

  describe("error handling", () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue("yaml content");
      vi.mocked(yaml.parse).mockReturnValue({});
      vi.mocked(yamlValidator.validateAgentConfig).mockReturnValue({
        valid: true,
      });
    });

    it("should handle authentication errors", async () => {
      vi.mocked(apiClient.createOrUpdateConfig).mockRejectedValue(
        new Error("Not authenticated"),
      );

      await expect(async () => {
        await buildCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle API errors with message", async () => {
      vi.mocked(apiClient.createOrUpdateConfig).mockRejectedValue(
        new Error("Failed to create config: Invalid name"),
      );

      await expect(async () => {
        await buildCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to create config"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle unexpected errors", async () => {
      vi.mocked(apiClient.createOrUpdateConfig).mockRejectedValue(
        "Non-error object",
      );

      await expect(async () => {
        await buildCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("unexpected error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
