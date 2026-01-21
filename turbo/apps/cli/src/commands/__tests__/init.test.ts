import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initCommand } from "../init";
import * as fs from "fs/promises";
import { existsSync, mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";
import * as yamlValidator from "../../lib/domain/yaml-validator";

// Mock dependencies
vi.mock("../../lib/domain/yaml-validator");
vi.mock("../../lib/utils/prompt-utils");

import * as promptUtils from "../../lib/utils/prompt-utils";

// Mock isInteractive to return true for tests that test interactive mode
vi.mocked(promptUtils.isInteractive).mockReturnValue(true);

describe("init command", () => {
  let tempDir: string;
  let originalCwd: string;

  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-init-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("file existence check", () => {
    it("should exit with error if vm0.yaml exists without --force", async () => {
      await fs.writeFile(path.join(tempDir, "vm0.yaml"), "existing content");

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
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "existing content");

      await expect(async () => {
        await initCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("AGENTS.md already exists"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error if both files exist without --force", async () => {
      await fs.writeFile(path.join(tempDir, "vm0.yaml"), "existing content");
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "existing content");

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
    it("should exit with error for invalid agent name", async () => {
      vi.mocked(promptUtils.promptText).mockResolvedValue("ab"); // Too short
      vi.mocked(yamlValidator.validateAgentName).mockReturnValue(false);

      await expect(async () => {
        await initCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Invalid agent name"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit gracefully when user cancels prompt", async () => {
      vi.mocked(promptUtils.promptText).mockResolvedValue(undefined); // User cancelled

      await initCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Cancelled"),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe("successful initialization", () => {
    beforeEach(() => {
      vi.mocked(yamlValidator.validateAgentName).mockReturnValue(true);
    });

    it("should create vm0.yaml and AGENTS.md with valid agent name", async () => {
      vi.mocked(promptUtils.promptText).mockResolvedValue("my-agent");

      await initCommand.parseAsync(["node", "cli"]);

      expect(existsSync(path.join(tempDir, "vm0.yaml"))).toBe(true);
      expect(existsSync(path.join(tempDir, "AGENTS.md"))).toBe(true);

      const yamlContent = await fs.readFile(
        path.join(tempDir, "vm0.yaml"),
        "utf8",
      );
      expect(yamlContent).toContain("my-agent");

      const mdContent = await fs.readFile(
        path.join(tempDir, "AGENTS.md"),
        "utf8",
      );
      expect(mdContent).toContain("Agent Instructions");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Created vm0.yaml"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Created AGENTS.md"),
      );
    });

    it("should include correct vm0.yaml template content", async () => {
      vi.mocked(promptUtils.promptText).mockResolvedValue("test-agent");

      await initCommand.parseAsync(["node", "cli"]);

      const content = await fs.readFile(path.join(tempDir, "vm0.yaml"), "utf8");

      expect(content).toContain('version: "1.0"');
      expect(content).toContain("test-agent:");
      expect(content).toContain("framework: claude-code");
      expect(content).toContain("instructions: AGENTS.md");
      expect(content).toContain(
        "# Build agentic workflow using natural language",
      );
      expect(content).toContain("# Agent skills");
      expect(content).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    });

    it("should display next steps after creation", async () => {
      vi.mocked(promptUtils.promptText).mockResolvedValue("my-agent");

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
    });

    it("should overwrite existing files with --force", async () => {
      await fs.writeFile(path.join(tempDir, "vm0.yaml"), "old content");
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "old content");
      vi.mocked(promptUtils.promptText).mockResolvedValue("my-agent");

      await initCommand.parseAsync(["node", "cli", "--force"]);

      const yamlContent = await fs.readFile(
        path.join(tempDir, "vm0.yaml"),
        "utf8",
      );
      const mdContent = await fs.readFile(
        path.join(tempDir, "AGENTS.md"),
        "utf8",
      );

      expect(yamlContent).not.toBe("old content");
      expect(mdContent).not.toBe("old content");
      expect(yamlContent).toContain("my-agent");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("(overwritten)"),
      );
    });

    it("should work with -f short option", async () => {
      await fs.writeFile(path.join(tempDir, "vm0.yaml"), "old content");
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "old content");
      vi.mocked(promptUtils.promptText).mockResolvedValue("my-agent");

      await initCommand.parseAsync(["node", "cli", "-f"]);

      expect(existsSync(path.join(tempDir, "vm0.yaml"))).toBe(true);
      expect(existsSync(path.join(tempDir, "AGENTS.md"))).toBe(true);
    });
  });

  describe("--name option", () => {
    beforeEach(() => {
      vi.mocked(yamlValidator.validateAgentName).mockReturnValue(true);
    });

    it("should skip interactive prompt when --name is provided", async () => {
      await initCommand.parseAsync(["node", "cli", "--name", "cli-agent"]);

      expect(promptUtils.promptText).not.toHaveBeenCalled();

      const content = await fs.readFile(path.join(tempDir, "vm0.yaml"), "utf8");
      expect(content).toContain("cli-agent");
    });

    it("should work with -n short option", async () => {
      await initCommand.parseAsync(["node", "cli", "-n", "short-agent"]);

      expect(promptUtils.promptText).not.toHaveBeenCalled();

      const content = await fs.readFile(path.join(tempDir, "vm0.yaml"), "utf8");
      expect(content).toContain("short-agent");
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
      await fs.writeFile(path.join(tempDir, "vm0.yaml"), "old content");
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "old content");

      await initCommand.parseAsync([
        "node",
        "cli",
        "--name",
        "forced-agent",
        "--force",
      ]);

      const content = await fs.readFile(path.join(tempDir, "vm0.yaml"), "utf8");
      expect(content).toContain("forced-agent");
      expect(content).not.toBe("old content");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("(overwritten)"),
      );
    });
  });
});
