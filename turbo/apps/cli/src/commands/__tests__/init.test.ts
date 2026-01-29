/**
 * Unit tests for the init command
 *
 * These tests validate init command behavior using real validators and
 * non-interactive mode (--name flag). Interactive prompts are not tested
 * per CLI testing principles.
 *
 * Key behaviors tested:
 * - File existence check (vm0.yaml, AGENTS.md)
 * - Agent name validation
 * - File creation and content
 * - --force and --name options
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initCommand } from "../init";
import * as fs from "fs/promises";
import { existsSync, mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

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
    chalk.level = 0;
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
        await initCommand.parseAsync(["node", "cli", "--name", "my-agent"]);
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
        await initCommand.parseAsync(["node", "cli", "--name", "my-agent"]);
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
        await initCommand.parseAsync(["node", "cli", "--name", "my-agent"]);
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
    it("should exit with error for invalid agent name (too short)", async () => {
      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "ab"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Invalid agent name"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error for invalid agent name (contains underscore)", async () => {
      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "my_agent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Invalid agent name"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error for invalid agent name (starts with hyphen)", async () => {
      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "-my-agent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Invalid agent name"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should show validation requirements on error", async () => {
      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "ab"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("3-64 characters"),
      );
    });
  });

  describe("successful initialization", () => {
    it("should create vm0.yaml and AGENTS.md with valid agent name", async () => {
      await initCommand.parseAsync(["node", "cli", "--name", "my-agent"]);

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
      await initCommand.parseAsync(["node", "cli", "--name", "test-agent"]);

      const content = await fs.readFile(path.join(tempDir, "vm0.yaml"), "utf8");

      expect(content).toContain('version: "1.0"');
      expect(content).toContain("test-agent:");
      expect(content).toContain("framework: claude-code");
      expect(content).toContain("instructions: AGENTS.md");
      expect(content).toContain(
        "# Build agentic workflow using natural language",
      );
      expect(content).toContain("# Agent skills");
    });

    it("should display next steps after creation", async () => {
      await initCommand.parseAsync(["node", "cli", "--name", "my-agent"]);

      expect(mockConsoleLog).toHaveBeenCalledWith("Next steps:");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0 model-provider setup"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("AGENTS.md"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0 cook"),
      );
    });

    it("should accept valid agent names with hyphens", async () => {
      await initCommand.parseAsync([
        "node",
        "cli",
        "--name",
        "my-super-agent-2024",
      ]);

      const content = await fs.readFile(path.join(tempDir, "vm0.yaml"), "utf8");
      expect(content).toContain("my-super-agent-2024:");
    });

    it("should accept valid agent names with numbers", async () => {
      await initCommand.parseAsync(["node", "cli", "--name", "agent123"]);

      const content = await fs.readFile(path.join(tempDir, "vm0.yaml"), "utf8");
      expect(content).toContain("agent123:");
    });
  });

  describe("--force option", () => {
    it("should overwrite existing files with --force", async () => {
      await fs.writeFile(path.join(tempDir, "vm0.yaml"), "old content");
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "old content");

      await initCommand.parseAsync([
        "node",
        "cli",
        "--name",
        "my-agent",
        "--force",
      ]);

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

      await initCommand.parseAsync(["node", "cli", "--name", "my-agent", "-f"]);

      expect(existsSync(path.join(tempDir, "vm0.yaml"))).toBe(true);
      expect(existsSync(path.join(tempDir, "AGENTS.md"))).toBe(true);
    });
  });

  describe("--name option", () => {
    it("should create files with name from --name flag", async () => {
      await initCommand.parseAsync(["node", "cli", "--name", "cli-agent"]);

      const content = await fs.readFile(path.join(tempDir, "vm0.yaml"), "utf8");
      expect(content).toContain("cli-agent:");
    });

    it("should work with -n short option", async () => {
      await initCommand.parseAsync(["node", "cli", "-n", "short-agent"]);

      const content = await fs.readFile(path.join(tempDir, "vm0.yaml"), "utf8");
      expect(content).toContain("short-agent:");
    });

    it("should validate agent name from --name option", async () => {
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
      expect(content).toContain("forced-agent:");
      expect(content).not.toBe("old content");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("(overwritten)"),
      );
    });

    it("should trim whitespace from agent name", async () => {
      await initCommand.parseAsync(["node", "cli", "--name", "  my-agent  "]);

      const content = await fs.readFile(path.join(tempDir, "vm0.yaml"), "utf8");
      expect(content).toContain("my-agent:");
    });
  });
});
