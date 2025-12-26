import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { composeCommand, transformExperimentalShorthand } from "../compose";
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
vi.mock("../../lib/provider-config", () => ({
  getProviderDefaults: vi.fn().mockReturnValue(undefined),
  getDefaultImage: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../lib/system-storage", () => ({
  uploadInstructions: vi.fn(),
  uploadSkill: vi.fn(),
}));

describe("compose command", () => {
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
        await composeCommand.parseAsync(["node", "cli", "nonexistent.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Config file not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should read file when it exists", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue("version: 1.0");
      vi.mocked(yaml.parse).mockReturnValue({
        version: "1.0",
        agents: { test: { provider: "test", working_dir: "/" } },
      });
      vi.mocked(yamlValidator.validateAgentCompose).mockReturnValue({
        valid: true,
      });
      vi.mocked(apiClient.createOrUpdateCompose).mockResolvedValue({
        composeId: "cmp-123",
        name: "test",
        versionId:
          "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
        action: "created",
      });

      await composeCommand.parseAsync(["node", "cli", "config.yaml"]);

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
        await composeCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid YAML format"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should parse valid YAML", async () => {
      const mockConfig = {
        version: "1.0",
        agents: { test: { working_dir: "/" } },
      };
      vi.mocked(yaml.parse).mockReturnValue(mockConfig);
      vi.mocked(yamlValidator.validateAgentCompose).mockReturnValue({
        valid: true,
      });
      vi.mocked(apiClient.createOrUpdateCompose).mockResolvedValue({
        composeId: "cmp-123",
        name: "test",
        versionId:
          "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
        action: "created",
      });

      await composeCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(yaml.parse).toHaveBeenCalled();
      expect(yamlValidator.validateAgentCompose).toHaveBeenCalledWith(
        mockConfig,
      );
    });
  });

  describe("compose validation", () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue("yaml content");
      vi.mocked(yaml.parse).mockReturnValue({
        version: "1.0",
        agents: { test: { provider: "test", working_dir: "/" } },
      });
    });

    it("should exit with error on invalid compose", async () => {
      vi.mocked(yamlValidator.validateAgentCompose).mockReturnValue({
        valid: false,
        error: "Missing agent.name",
      });

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Missing agent.name"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should proceed with valid compose", async () => {
      vi.mocked(yamlValidator.validateAgentCompose).mockReturnValue({
        valid: true,
      });
      vi.mocked(apiClient.createOrUpdateCompose).mockResolvedValue({
        composeId: "cmp-123",
        name: "test",
        versionId:
          "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
        action: "created",
      });

      await composeCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(apiClient.createOrUpdateCompose).toHaveBeenCalled();
    });
  });

  describe("API interaction", () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue("yaml content");
      vi.mocked(yaml.parse).mockReturnValue({
        version: "1.0",
        agents: { test: { working_dir: "/" } },
      });
      vi.mocked(yamlValidator.validateAgentCompose).mockReturnValue({
        valid: true,
      });
    });

    it("should display loading message", async () => {
      vi.mocked(apiClient.createOrUpdateCompose).mockResolvedValue({
        composeId: "cmp-123",
        name: "test",
        versionId:
          "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
        action: "created",
      });

      await composeCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Uploading compose"),
      );
    });

    it("should display created message", async () => {
      vi.mocked(apiClient.createOrUpdateCompose).mockResolvedValue({
        composeId: "cmp-123",
        name: "test-agent",
        versionId:
          "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
        action: "created",
      });

      await composeCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose created: test-agent"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose ID: cmp-123"),
      );
    });

    it("should display 'version exists' message", async () => {
      vi.mocked(apiClient.createOrUpdateCompose).mockResolvedValue({
        composeId: "cmp-123",
        name: "test-agent",
        versionId:
          "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
        action: "existing",
      });

      await composeCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose version exists: test-agent"),
      );
    });

    it("should display usage instructions", async () => {
      vi.mocked(apiClient.createOrUpdateCompose).mockResolvedValue({
        composeId: "cmp-123",
        name: "test",
        versionId:
          "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
        action: "created",
      });

      await composeCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0 run test"),
      );
    });
  });

  describe("error handling", () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue("yaml content");
      vi.mocked(yaml.parse).mockReturnValue({
        version: "1.0",
        agents: { test: { provider: "test", working_dir: "/" } },
      });
      vi.mocked(yamlValidator.validateAgentCompose).mockReturnValue({
        valid: true,
      });
    });

    it("should handle authentication errors", async () => {
      vi.mocked(apiClient.createOrUpdateCompose).mockRejectedValue(
        new Error("Not authenticated"),
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "config.yaml"]);
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
      vi.mocked(apiClient.createOrUpdateCompose).mockRejectedValue(
        new Error("Failed to create compose: Invalid name"),
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to create compose"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should handle unexpected errors", async () => {
      vi.mocked(apiClient.createOrUpdateCompose).mockRejectedValue(
        "Non-error object",
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("unexpected error"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});

describe("transformExperimentalShorthand", () => {
  it("should transform experimental_secrets to environment", () => {
    const agent: Record<string, unknown> = {
      provider: "claude-code",
      experimental_secrets: ["API_KEY", "DB_URL"],
    };
    transformExperimentalShorthand(agent);

    expect(agent.environment).toEqual({
      API_KEY: "${{ secrets.API_KEY }}",
      DB_URL: "${{ secrets.DB_URL }}",
    });
    expect(agent.experimental_secrets).toBeUndefined();
  });

  it("should transform experimental_vars to environment", () => {
    const agent: Record<string, unknown> = {
      provider: "claude-code",
      experimental_vars: ["CLOUD_NAME", "REGION"],
    };
    transformExperimentalShorthand(agent);

    expect(agent.environment).toEqual({
      CLOUD_NAME: "${{ vars.CLOUD_NAME }}",
      REGION: "${{ vars.REGION }}",
    });
    expect(agent.experimental_vars).toBeUndefined();
  });

  it("should preserve explicit environment over shorthand (secrets)", () => {
    const agent: Record<string, unknown> = {
      provider: "claude-code",
      experimental_secrets: ["API_KEY"],
      environment: {
        API_KEY: "${{ secrets.DIFFERENT_KEY }}",
      },
    };
    transformExperimentalShorthand(agent);

    expect(agent.environment).toEqual({
      API_KEY: "${{ secrets.DIFFERENT_KEY }}",
    });
  });

  it("should preserve explicit environment over shorthand (vars)", () => {
    const agent: Record<string, unknown> = {
      provider: "claude-code",
      experimental_vars: ["CLOUD_NAME"],
      environment: {
        CLOUD_NAME: "explicit-value",
      },
    };
    transformExperimentalShorthand(agent);

    expect(agent.environment).toEqual({
      CLOUD_NAME: "explicit-value",
    });
  });

  it("should combine all three sources correctly", () => {
    const agent: Record<string, unknown> = {
      provider: "claude-code",
      experimental_secrets: ["SECRET1", "SECRET2"],
      experimental_vars: ["VAR1"],
      environment: {
        SECRET2: "${{ secrets.OVERRIDE }}",
        EXPLICIT: "https://api.example.com",
      },
    };
    transformExperimentalShorthand(agent);

    expect(agent.environment).toEqual({
      SECRET1: "${{ secrets.SECRET1 }}",
      SECRET2: "${{ secrets.OVERRIDE }}",
      VAR1: "${{ vars.VAR1 }}",
      EXPLICIT: "https://api.example.com",
    });
    expect(agent.experimental_secrets).toBeUndefined();
    expect(agent.experimental_vars).toBeUndefined();
  });

  it("should not modify agent without shorthand fields", () => {
    const agent: Record<string, unknown> = {
      provider: "claude-code",
      environment: { KEY: "value" },
    };
    transformExperimentalShorthand(agent);

    expect(agent.environment).toEqual({ KEY: "value" });
    expect(agent.experimental_secrets).toBeUndefined();
    expect(agent.experimental_vars).toBeUndefined();
  });

  it("should handle empty arrays", () => {
    const agent: Record<string, unknown> = {
      provider: "claude-code",
      experimental_secrets: [],
      experimental_vars: [],
    };
    transformExperimentalShorthand(agent);

    expect(agent.experimental_secrets).toBeUndefined();
    expect(agent.experimental_vars).toBeUndefined();
    expect(agent.environment).toBeUndefined();
  });

  it("should create environment when only shorthand provided", () => {
    const agent: Record<string, unknown> = {
      provider: "claude-code",
      experimental_secrets: ["API_KEY"],
    };
    transformExperimentalShorthand(agent);

    expect(agent.environment).toEqual({
      API_KEY: "${{ secrets.API_KEY }}",
    });
  });

  it("should handle agent with no shorthand or environment", () => {
    const agent: Record<string, unknown> = {
      provider: "claude-code",
    };
    transformExperimentalShorthand(agent);

    expect(agent.environment).toBeUndefined();
  });
});
