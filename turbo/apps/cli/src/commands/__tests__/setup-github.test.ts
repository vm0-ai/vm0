import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupGithubCommand } from "../setup-github";
import * as fs from "fs/promises";
import { existsSync, mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";
import { execSync, spawnSync, SpawnSyncReturns } from "child_process";
import * as config from "../../lib/api/config";
import * as core from "@vm0/core";

// Mock dependencies
vi.mock("child_process");
vi.mock("../../lib/api/config");
vi.mock("@vm0/core");
vi.mock("../../lib/utils/prompt-utils");

import * as promptUtils from "../../lib/utils/prompt-utils";

describe("setup-github command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default mocks for core functions
    vi.mocked(core.extractVariableReferences).mockReturnValue([]);
    vi.mocked(core.groupVariablesBySource).mockReturnValue({
      env: [],
      vars: [],
      secrets: [],
      credentials: [],
    });

    // Create temporary directory and change to it
    originalCwd = process.cwd();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-setup-github-"));
    process.chdir(tempDir);
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();

    // Restore original directory and clean up
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("prerequisite checks", () => {
    it("should exit with error if not in a git repository", async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          throw new Error("not a git repository");
        }
        return Buffer.from("");
      });

      await expect(async () => {
        await setupGithubCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Not in a git repository"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("git init"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error if gh CLI is not installed", async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return "/repo";
        }
        if (cmd === "gh --version") {
          throw new Error("command not found");
        }
        return Buffer.from("");
      });

      await expect(async () => {
        await setupGithubCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("GitHub CLI (gh) is not installed"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("brew install gh"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error if gh CLI is not authenticated", async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return "/repo";
        }
        if (cmd === "gh --version") {
          return Buffer.from("gh version 2.0.0");
        }
        if (cmd === "gh auth status") {
          throw new Error("not authenticated");
        }
        return Buffer.from("");
      });

      await expect(async () => {
        await setupGithubCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("GitHub CLI is not authenticated"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("gh auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error if VM0 is not authenticated", async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return "/repo";
        }
        return Buffer.from("");
      });
      vi.mocked(config.getToken).mockResolvedValue(undefined);

      await expect(async () => {
        await setupGithubCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("VM0 not authenticated"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error if vm0.yaml does not exist", async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return tempDir;
        }
        return Buffer.from("");
      });
      vi.mocked(config.getToken).mockResolvedValue("test-token");
      // Don't create vm0.yaml file - it should not exist

      await expect(async () => {
        await setupGithubCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0.yaml not found"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0 init"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("workflow file generation", () => {
    beforeEach(async () => {
      // Pass all prerequisites - mock git root at tempDir, already in tempDir
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return tempDir;
        }
        return Buffer.from("");
      });
      vi.mocked(config.getToken).mockResolvedValue("test-token");

      // Create real vm0.yaml file
      await fs.writeFile(
        "vm0.yaml",
        `version: "1.0"
agents:
  my-test-agent:
    framework: claude-code
    instructions: AGENTS.md
`,
      );

      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
      } as SpawnSyncReturns<Buffer>);
    });

    it("should create publish.yml with correct content", async () => {
      vi.mocked(promptUtils.promptConfirm).mockResolvedValue(false); // Skip auto-setup

      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      // Read the actual file that was written
      const publishPath = path.join(
        tempDir,
        ".github",
        "workflows",
        "publish.yml",
      );
      expect(existsSync(publishPath)).toBe(true);
      const content = await fs.readFile(publishPath, "utf-8");

      expect(content).toContain("name: Publish Agent");
      expect(content).toContain("branches: [main]");
      expect(content).toContain("vm0.yaml");
      expect(content).toContain("AGENTS.md");
      expect(content).toContain("vm0-ai/compose-action@v1");
      expect(content).toContain("secrets.VM0_TOKEN");
    });

    it("should create run.yml with agent name", async () => {
      vi.mocked(promptUtils.promptConfirm).mockResolvedValue(false);

      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      // Read the actual file that was written
      const runPath = path.join(tempDir, ".github", "workflows", "run.yml");
      expect(existsSync(runPath)).toBe(true);
      const content = await fs.readFile(runPath, "utf-8");

      expect(content).toContain("name: Run Agent");
      expect(content).toContain("workflow_dispatch:");
      expect(content).toContain("agent: my-test-agent");
      expect(content).toContain("vm0-ai/run-action@v1");
      expect(content).toContain("secrets.VM0_TOKEN");
    });

    it("should include detected secrets in run.yml", async () => {
      vi.mocked(core.extractVariableReferences).mockReturnValue([
        {
          source: "secrets",
          name: "API_KEY",
          fullMatch: "${{ secrets.API_KEY }}",
        },
      ]);
      vi.mocked(core.groupVariablesBySource).mockReturnValue({
        env: [],
        vars: [],
        secrets: [
          {
            source: "secrets",
            name: "API_KEY",
            fullMatch: "${{ secrets.API_KEY }}",
          },
        ],
        credentials: [],
      });

      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      // Read the actual file that was written
      const runPath = path.join(tempDir, ".github", "workflows", "run.yml");
      const content = await fs.readFile(runPath, "utf-8");

      expect(content).toContain("secrets: |");
      expect(content).toContain("API_KEY=${{ secrets.API_KEY }}");
    });

    it("should include detected vars in run.yml", async () => {
      vi.mocked(core.extractVariableReferences).mockReturnValue([
        { source: "vars", name: "REGION", fullMatch: "${{ vars.REGION }}" },
      ]);
      vi.mocked(core.groupVariablesBySource).mockReturnValue({
        env: [],
        vars: [
          { source: "vars", name: "REGION", fullMatch: "${{ vars.REGION }}" },
        ],
        secrets: [],
        credentials: [],
      });

      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      // Read the actual file that was written
      const runPath = path.join(tempDir, ".github", "workflows", "run.yml");
      const content = await fs.readFile(runPath, "utf-8");

      expect(content).toContain("vars: |");
      expect(content).toContain("REGION=${{ vars.REGION }}");
    });

    it("should handle experimental_secrets and experimental_vars", async () => {
      // Overwrite vm0.yaml with experimental fields
      await fs.writeFile(
        "vm0.yaml",
        `version: "1.0"
agents:
  my-test-agent:
    framework: claude-code
    instructions: AGENTS.md
    experimental_secrets:
      - CUSTOM_SECRET
    experimental_vars:
      - CUSTOM_VAR
`,
      );

      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      // Read the actual file that was written
      const content = await fs.readFile(".github/workflows/run.yml", "utf-8");

      expect(content).toContain("CUSTOM_SECRET=${{ secrets.CUSTOM_SECRET }}");
      expect(content).toContain("CUSTOM_VAR=${{ vars.CUSTOM_VAR }}");
    });
  });

  describe("existing file handling", () => {
    beforeEach(async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return tempDir;
        }
        return Buffer.from("");
      });
      vi.mocked(config.getToken).mockResolvedValue("test-token");

      // Create real vm0.yaml file
      await fs.writeFile(
        "vm0.yaml",
        `version: "1.0"
agents:
  my-agent:
    framework: claude-code
`,
      );
    });

    it("should prompt to overwrite existing files", async () => {
      // Create existing workflow file
      await fs.mkdir(".github/workflows", { recursive: true });
      await fs.writeFile(".github/workflows/publish.yml", "existing content");

      vi.mocked(promptUtils.promptConfirm).mockResolvedValue(false); // No, don't overwrite

      await expect(async () => {
        await setupGithubCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Existing workflow files detected"),
      );
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it("should overwrite files with --force option", async () => {
      // Create existing workflow file
      await fs.mkdir(".github/workflows", { recursive: true });
      await fs.writeFile(".github/workflows/publish.yml", "existing content");

      await setupGithubCommand.parseAsync([
        "node",
        "cli",
        "--force",
        "--skip-secrets",
      ]);

      // Verify file was overwritten
      const content = await fs.readFile(
        ".github/workflows/publish.yml",
        "utf-8",
      );
      expect(content).not.toBe("existing content");
      expect(content).toContain("name: Publish Agent");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Overwrote"),
      );
    });

    it("should work with -f short option", async () => {
      // Create existing workflow file
      await fs.mkdir(".github/workflows", { recursive: true });
      await fs.writeFile(".github/workflows/publish.yml", "existing content");

      await setupGithubCommand.parseAsync([
        "node",
        "cli",
        "-f",
        "--skip-secrets",
      ]);

      // Verify file was written
      expect(existsSync(".github/workflows/publish.yml")).toBe(true);
    });
  });

  describe("--skip-secrets option", () => {
    beforeEach(async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return tempDir;
        }
        return Buffer.from("");
      });
      vi.mocked(config.getToken).mockResolvedValue("test-token");

      // Create real vm0.yaml file
      await fs.writeFile(
        "vm0.yaml",
        `version: "1.0"
agents:
  my-agent:
    framework: claude-code
`,
      );
    });

    it("should skip secrets setup with --skip-secrets", async () => {
      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      expect(spawnSync).not.toHaveBeenCalledWith(
        "gh",
        expect.arrayContaining(["secret", "set"]),
        expect.any(Object),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Done (secrets setup skipped)"),
      );
    });
  });

  describe("--yes option", () => {
    beforeEach(async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return tempDir;
        }
        return Buffer.from("");
      });
      vi.mocked(config.getToken).mockResolvedValue("test-token");

      // Create real vm0.yaml file and existing workflow file
      await fs.writeFile(
        "vm0.yaml",
        `version: "1.0"
agents:
  my-agent:
    framework: claude-code
`,
      );
      await fs.mkdir(".github/workflows", { recursive: true });
      await fs.writeFile(".github/workflows/publish.yml", "existing content");

      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
      } as SpawnSyncReturns<Buffer>);
    });

    it("should auto-confirm prompts with --yes", async () => {
      await setupGithubCommand.parseAsync(["node", "cli", "--yes"]);

      // Should not have prompted the user
      expect(promptUtils.promptConfirm).not.toHaveBeenCalled();

      // Should have proceeded with overwriting and setting secrets
      expect(existsSync(".github/workflows/publish.yml")).toBe(true);
      const content = await fs.readFile(
        ".github/workflows/publish.yml",
        "utf-8",
      );
      expect(content).toContain("name: Publish Agent");
    });

    it("should work with -y short option", async () => {
      await setupGithubCommand.parseAsync(["node", "cli", "-y"]);

      expect(promptUtils.promptConfirm).not.toHaveBeenCalled();
      expect(existsSync(".github/workflows/publish.yml")).toBe(true);
    });
  });

  describe("secrets setup", () => {
    beforeEach(async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return tempDir;
        }
        return Buffer.from("");
      });
      vi.mocked(config.getToken).mockResolvedValue("test-token");

      // Create real vm0.yaml file
      await fs.writeFile(
        "vm0.yaml",
        `version: "1.0"
agents:
  my-agent:
    framework: claude-code
`,
      );
    });

    it("should set VM0_TOKEN secret when auto-setup is confirmed", async () => {
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
      } as SpawnSyncReturns<Buffer>);

      await setupGithubCommand.parseAsync(["node", "cli", "--yes"]);

      expect(spawnSync).toHaveBeenCalledWith(
        "gh",
        ["secret", "set", "VM0_TOKEN"],
        expect.objectContaining({
          input: "test-token",
        }),
      );
    });

    it("should detect secrets from environment variables", async () => {
      // Use bracket notation to avoid turbo env var lint warnings
      const TEST_SECRET = "CUSTOM_TEST_SECRET";
      vi.stubEnv(TEST_SECRET, "test-secret-value");

      vi.mocked(core.extractVariableReferences).mockReturnValue([
        {
          source: "secrets",
          name: TEST_SECRET,
          fullMatch: `\${{ secrets.${TEST_SECRET} }}`,
        },
      ]);
      vi.mocked(core.groupVariablesBySource).mockReturnValue({
        env: [],
        vars: [],
        secrets: [
          {
            source: "secrets",
            name: TEST_SECRET,
            fullMatch: `\${{ secrets.${TEST_SECRET} }}`,
          },
        ],
        credentials: [],
      });
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
      } as SpawnSyncReturns<Buffer>);

      await setupGithubCommand.parseAsync(["node", "cli", "--yes"]);

      expect(spawnSync).toHaveBeenCalledWith(
        "gh",
        ["secret", "set", TEST_SECRET],
        expect.objectContaining({
          input: "test-secret-value",
        }),
      );
    });

    it("should show manual setup instructions when declining auto-setup", async () => {
      vi.mocked(promptUtils.promptConfirm).mockResolvedValue(false); // No, don't auto-setup

      await setupGithubCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Configure secrets manually"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("gh secret set VM0_TOKEN"),
      );
    });

    it("should handle failed secret setting gracefully", async () => {
      vi.mocked(spawnSync).mockReturnValue({
        status: 1,
      } as SpawnSyncReturns<Buffer>);

      await setupGithubCommand.parseAsync(["node", "cli", "--yes"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("VM0_TOKEN (failed)"),
      );
    });
  });

  describe("display messages", () => {
    beforeEach(async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return tempDir;
        }
        return Buffer.from("");
      });
      vi.mocked(config.getToken).mockResolvedValue("test-token");

      // Create real vm0.yaml file
      await fs.writeFile(
        "vm0.yaml",
        `version: "1.0"
agents:
  my-agent:
    framework: claude-code
`,
      );

      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
      } as SpawnSyncReturns<Buffer>);
    });

    it("should show success message when all secrets are set", async () => {
      await setupGithubCommand.parseAsync(["node", "cli", "--yes"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("GitHub Actions setup complete"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Commit and push the workflow files"),
      );
    });

    it("should show partial success message when some secrets are missing", async () => {
      vi.mocked(core.extractVariableReferences).mockReturnValue([
        {
          source: "secrets",
          name: "MISSING_SECRET",
          fullMatch: "${{ secrets.MISSING_SECRET }}",
        },
      ]);
      vi.mocked(core.groupVariablesBySource).mockReturnValue({
        env: [],
        vars: [],
        secrets: [
          {
            source: "secrets",
            name: "MISSING_SECRET",
            fullMatch: "${{ secrets.MISSING_SECRET }}",
          },
        ],
        credentials: [],
      });

      await setupGithubCommand.parseAsync(["node", "cli", "--yes"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Setup partially complete"),
      );
    });
  });

  describe("subdirectory execution", () => {
    beforeEach(async () => {
      // Create subdirectory and change to it
      await fs.mkdir(".vm0", { recursive: true });
      process.chdir(".vm0");

      // Mock git root at tempDir (parent), cwd is now in subdirectory
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return tempDir;
        }
        return Buffer.from("");
      });
      vi.mocked(config.getToken).mockResolvedValue("test-token");

      // Create real vm0.yaml file in current directory (subdirectory)
      await fs.writeFile(
        "vm0.yaml",
        `version: "1.0"
agents:
  subdir-agent:
    framework: claude-code
    instructions: AGENTS.md
`,
      );

      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
      } as SpawnSyncReturns<Buffer>);
    });

    afterEach(() => {
      // Return to tempDir after subdirectory tests
      process.chdir(tempDir);
    });

    it("should include working-directory in publish.yml when run from subdirectory", async () => {
      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      // Read the actual file that was written
      const publishPath = path.join(
        tempDir,
        ".github",
        "workflows",
        "publish.yml",
      );
      const content = await fs.readFile(publishPath, "utf-8");

      expect(content).toContain("working-directory: .vm0");
      expect(content).toContain("'.vm0/vm0.yaml'");
      expect(content).toContain("'.vm0/AGENTS.md'");
    });

    it("should write workflow files to git root .github directory", async () => {
      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      // Verify files were written to git root
      const publishPath = path.join(
        tempDir,
        ".github",
        "workflows",
        "publish.yml",
      );
      const runPath = path.join(tempDir, ".github", "workflows", "run.yml");

      expect(existsSync(publishPath)).toBe(true);
      expect(existsSync(runPath)).toBe(true);
    });

    it("should NOT include working-directory in run.yml (run-action does not need it)", async () => {
      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      // Read the actual file that was written
      const runPath = path.join(tempDir, ".github", "workflows", "run.yml");
      const content = await fs.readFile(runPath, "utf-8");

      expect(content).not.toContain("working-directory");
    });
  });

  describe("git root execution (no subdirectory)", () => {
    beforeEach(async () => {
      // Mock git root and cwd both at tempDir (at git root)
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return tempDir;
        }
        return Buffer.from("");
      });
      vi.mocked(config.getToken).mockResolvedValue("test-token");

      // Create real vm0.yaml file at git root (current directory)
      await fs.writeFile(
        "vm0.yaml",
        `version: "1.0"
agents:
  root-agent:
    framework: claude-code
    instructions: AGENTS.md
`,
      );

      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
      } as SpawnSyncReturns<Buffer>);
    });

    it("should NOT include working-directory when run from git root", async () => {
      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      // Read the actual file that was written
      const publishPath = path.join(
        tempDir,
        ".github",
        "workflows",
        "publish.yml",
      );
      const content = await fs.readFile(publishPath, "utf-8");

      expect(content).not.toContain("working-directory");
      expect(content).toContain("'vm0.yaml'");
      expect(content).toContain("'AGENTS.md'");
    });
  });

  describe("nested subdirectory execution", () => {
    beforeEach(async () => {
      // Create nested subdirectory and change to it
      await fs.mkdir("configs/agents", { recursive: true });
      process.chdir("configs/agents");

      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return tempDir;
        }
        return Buffer.from("");
      });
      vi.mocked(config.getToken).mockResolvedValue("test-token");

      // Create real vm0.yaml file in current directory (nested subdirectory)
      await fs.writeFile(
        "vm0.yaml",
        `version: "1.0"
agents:
  nested-agent:
    framework: claude-code
    instructions: AGENTS.md
`,
      );

      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
      } as SpawnSyncReturns<Buffer>);
    });

    afterEach(() => {
      // Return to tempDir after nested subdirectory tests
      process.chdir(tempDir);
    });

    it("should handle nested subdirectory paths correctly", async () => {
      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      // Read the actual file that was written
      const publishPath = path.join(
        tempDir,
        ".github",
        "workflows",
        "publish.yml",
      );
      const content = await fs.readFile(publishPath, "utf-8");

      expect(content).toContain("working-directory: configs/agents");
      expect(content).toContain("'configs/agents/vm0.yaml'");
      expect(content).toContain("'configs/agents/AGENTS.md'");
    });
  });
});
