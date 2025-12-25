import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initCommand } from "../init";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import * as readline from "readline";
import * as yamlValidator from "../../lib/yaml-validator";

// Mock dependencies
vi.mock("fs/promises");
vi.mock("fs");
vi.mock("readline");
vi.mock("../../lib/yaml-validator");

describe("init command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  // Mock readline interface
  const mockRlQuestion = vi.fn();
  const mockRlClose = vi.fn();
  const mockRlOn = vi.fn();
  const mockRlInterface = {
    question: mockRlQuestion,
    close: mockRlClose,
    on: mockRlOn,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readline.createInterface).mockReturnValue(
      mockRlInterface as unknown as readline.Interface,
    );
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("file existence check", () => {
    it("should exit with error if vm0.yaml exists without --force", async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        return path === "vm0.yaml";
      });

      await expect(async () => {
        await initCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0.yaml already exists"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0 init --force"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error if AGENTS.md exists without --force", async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        return path === "AGENTS.md";
      });

      await expect(async () => {
        await initCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("AGENTS.md already exists"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error if both files exist without --force", async () => {
      vi.mocked(existsSync).mockReturnValue(true);

      await expect(async () => {
        await initCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0.yaml already exists"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("AGENTS.md already exists"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("agent name validation", () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReturnValue(false);
    });

    it("should exit with error for invalid agent name", async () => {
      mockRlQuestion.mockImplementation((_, callback) => {
        callback("ab"); // Too short
      });
      vi.mocked(yamlValidator.validateAgentName).mockReturnValue(false);

      await expect(async () => {
        await initCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Invalid agent name"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error for empty agent name", async () => {
      mockRlQuestion.mockImplementation((_, callback) => {
        callback("");
      });
      vi.mocked(yamlValidator.validateAgentName).mockReturnValue(false);

      await expect(async () => {
        await initCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Invalid agent name"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("successful initialization", () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(yamlValidator.validateAgentName).mockReturnValue(true);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    });

    it("should create vm0.yaml and AGENTS.md with valid agent name", async () => {
      mockRlQuestion.mockImplementation((_, callback) => {
        callback("my-agent");
      });

      await initCommand.parseAsync(["node", "cli"]);

      expect(fs.writeFile).toHaveBeenCalledWith(
        "vm0.yaml",
        expect.stringContaining("my-agent"),
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        "AGENTS.md",
        expect.stringContaining("Agent Instructions"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Created vm0.yaml"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Created AGENTS.md"),
      );
    });

    it("should include correct vm0.yaml template content", async () => {
      mockRlQuestion.mockImplementation((_, callback) => {
        callback("test-agent");
      });

      await initCommand.parseAsync(["node", "cli"]);

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => call[0] === "vm0.yaml");
      expect(writeCall).toBeDefined();
      const content = writeCall![1] as string;

      expect(content).toContain('version: "1.0"');
      expect(content).toContain("test-agent:");
      expect(content).toContain("provider: claude-code");
      expect(content).toContain("instructions: AGENTS.md");
      expect(content).toContain(
        "# Build agentic workflow using natural language",
      );
      expect(content).toContain("# Agent skills");
      expect(content).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    });

    it("should display next steps after creation", async () => {
      mockRlQuestion.mockImplementation((_, callback) => {
        callback("my-agent");
      });

      await initCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith("Next steps:");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("claude setup-token"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("CLAUDE_CODE_OAUTH_TOKEN"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0 cook"),
      );
    });
  });

  describe("--force option", () => {
    beforeEach(() => {
      vi.mocked(yamlValidator.validateAgentName).mockReturnValue(true);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    });

    it("should overwrite existing files with --force", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      mockRlQuestion.mockImplementation((_, callback) => {
        callback("my-agent");
      });

      await initCommand.parseAsync(["node", "cli", "--force"]);

      expect(fs.writeFile).toHaveBeenCalledWith("vm0.yaml", expect.any(String));
      expect(fs.writeFile).toHaveBeenCalledWith(
        "AGENTS.md",
        expect.any(String),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("(overwritten)"),
      );
    });

    it("should work with -f short option", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      mockRlQuestion.mockImplementation((_, callback) => {
        callback("my-agent");
      });

      await initCommand.parseAsync(["node", "cli", "-f"]);

      expect(fs.writeFile).toHaveBeenCalled();
    });
  });

  describe("--name option", () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(yamlValidator.validateAgentName).mockReturnValue(true);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    });

    it("should skip interactive prompt when --name is provided", async () => {
      await initCommand.parseAsync(["node", "cli", "--name", "cli-agent"]);

      expect(mockRlQuestion).not.toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalledWith(
        "vm0.yaml",
        expect.stringContaining("cli-agent"),
      );
    });

    it("should work with -n short option", async () => {
      await initCommand.parseAsync(["node", "cli", "-n", "short-agent"]);

      expect(mockRlQuestion).not.toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalledWith(
        "vm0.yaml",
        expect.stringContaining("short-agent"),
      );
    });

    it("should validate agent name from --name option", async () => {
      vi.mocked(yamlValidator.validateAgentName).mockReturnValue(false);

      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "ab"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Invalid agent name"),
      );
    });

    it("should work with --name and --force together", async () => {
      vi.mocked(existsSync).mockReturnValue(true);

      await initCommand.parseAsync([
        "node",
        "cli",
        "--name",
        "forced-agent",
        "--force",
      ]);

      expect(fs.writeFile).toHaveBeenCalledWith(
        "vm0.yaml",
        expect.stringContaining("forced-agent"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("(overwritten)"),
      );
    });
  });
});
