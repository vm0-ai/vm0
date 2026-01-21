import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupGithubCommand } from "../setup-github";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import { execSync, spawnSync, SpawnSyncReturns } from "child_process";
import * as config from "../../lib/api/config";
import * as core from "@vm0/core";

// Mock dependencies
vi.mock("fs/promises");
vi.mock("fs");
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
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
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
          return "/repo";
        }
        return Buffer.from("");
      });
      vi.mocked(config.getToken).mockResolvedValue("test-token");
      vi.mocked(existsSync).mockImplementation((path) => {
        if (path === "vm0.yaml") return false;
        return false;
      });

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
    const mockCwd = "/repo";

    beforeEach(() => {
      // Pass all prerequisites - mock git root at /repo, cwd at /repo (git root)
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return mockCwd;
        }
        return Buffer.from("");
      });
      vi.spyOn(process, "cwd").mockReturnValue(mockCwd);
      vi.mocked(config.getToken).mockResolvedValue("test-token");
      vi.mocked(existsSync).mockImplementation((path) => {
        if (path === "vm0.yaml") return true;
        return false;
      });
      vi.mocked(fs.readFile).mockResolvedValue(`
version: "1.0"
agents:
  my-test-agent:
    provider: claude-code
    instructions: AGENTS.md
`);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
      } as SpawnSyncReturns<Buffer>);
    });

    it("should create publish.yml with correct content", async () => {
      vi.mocked(promptUtils.promptConfirm).mockResolvedValue(false); // Skip auto-setup

      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => String(call[0]).includes("publish.yml"));
      expect(writeCall).toBeDefined();
      const content = writeCall![1] as string;

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

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => String(call[0]).includes("run.yml"));
      expect(writeCall).toBeDefined();
      const content = writeCall![1] as string;

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

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => String(call[0]).includes("run.yml"));
      expect(writeCall).toBeDefined();
      const content = writeCall![1] as string;

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

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => String(call[0]).includes("run.yml"));
      expect(writeCall).toBeDefined();
      const content = writeCall![1] as string;

      expect(content).toContain("vars: |");
      expect(content).toContain("REGION=${{ vars.REGION }}");
    });

    it("should handle experimental_secrets and experimental_vars", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(`
version: "1.0"
agents:
  my-test-agent:
    provider: claude-code
    instructions: AGENTS.md
    experimental_secrets:
      - CUSTOM_SECRET
    experimental_vars:
      - CUSTOM_VAR
`);

      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => String(call[0]).includes("run.yml"));
      expect(writeCall).toBeDefined();
      const content = writeCall![1] as string;

      expect(content).toContain("CUSTOM_SECRET=${{ secrets.CUSTOM_SECRET }}");
      expect(content).toContain("CUSTOM_VAR=${{ vars.CUSTOM_VAR }}");
    });
  });

  describe("existing file handling", () => {
    const mockCwd = "/repo";

    beforeEach(() => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return mockCwd;
        }
        return Buffer.from("");
      });
      vi.spyOn(process, "cwd").mockReturnValue(mockCwd);
      vi.mocked(config.getToken).mockResolvedValue("test-token");
      vi.mocked(fs.readFile).mockResolvedValue(`
version: "1.0"
agents:
  my-agent:
    provider: claude-code
`);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    });

    it("should prompt to overwrite existing files", async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        if (path === "vm0.yaml") return true;
        if (String(path).includes("publish.yml")) return true;
        return false;
      });

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
      vi.mocked(existsSync).mockImplementation((path) => {
        if (path === "vm0.yaml") return true;
        if (String(path).includes("publish.yml")) return true;
        return false;
      });

      await setupGithubCommand.parseAsync([
        "node",
        "cli",
        "--force",
        "--skip-secrets",
      ]);

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining("publish.yml"),
        expect.any(String),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Overwrote"),
      );
    });

    it("should work with -f short option", async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        if (path === "vm0.yaml") return true;
        if (String(path).includes("publish.yml")) return true;
        return false;
      });

      await setupGithubCommand.parseAsync([
        "node",
        "cli",
        "-f",
        "--skip-secrets",
      ]);

      expect(fs.writeFile).toHaveBeenCalled();
    });
  });

  describe("--skip-secrets option", () => {
    const mockCwd = "/repo";

    beforeEach(() => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return mockCwd;
        }
        return Buffer.from("");
      });
      vi.spyOn(process, "cwd").mockReturnValue(mockCwd);
      vi.mocked(config.getToken).mockResolvedValue("test-token");
      vi.mocked(existsSync).mockImplementation((path) => {
        if (path === "vm0.yaml") return true;
        return false;
      });
      vi.mocked(fs.readFile).mockResolvedValue(`
version: "1.0"
agents:
  my-agent:
    provider: claude-code
`);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
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
    const mockCwd = "/repo";

    beforeEach(() => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return mockCwd;
        }
        return Buffer.from("");
      });
      vi.spyOn(process, "cwd").mockReturnValue(mockCwd);
      vi.mocked(config.getToken).mockResolvedValue("test-token");
      vi.mocked(existsSync).mockImplementation((path) => {
        if (path === "vm0.yaml") return true;
        if (String(path).includes("publish.yml")) return true;
        return false;
      });
      vi.mocked(fs.readFile).mockResolvedValue(`
version: "1.0"
agents:
  my-agent:
    provider: claude-code
`);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
      } as SpawnSyncReturns<Buffer>);
    });

    it("should auto-confirm prompts with --yes", async () => {
      await setupGithubCommand.parseAsync(["node", "cli", "--yes"]);

      // Should not have prompted the user
      expect(promptUtils.promptConfirm).not.toHaveBeenCalled();
      // Should have proceeded with overwriting and setting secrets
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it("should work with -y short option", async () => {
      await setupGithubCommand.parseAsync(["node", "cli", "-y"]);

      expect(promptUtils.promptConfirm).not.toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();
    });
  });

  describe("secrets setup", () => {
    const mockCwd = "/repo";

    beforeEach(() => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return mockCwd;
        }
        return Buffer.from("");
      });
      vi.spyOn(process, "cwd").mockReturnValue(mockCwd);
      vi.mocked(config.getToken).mockResolvedValue("test-token");
      vi.mocked(existsSync).mockImplementation((path) => {
        if (path === "vm0.yaml") return true;
        return false;
      });
      vi.mocked(fs.readFile).mockResolvedValue(`
version: "1.0"
agents:
  my-agent:
    provider: claude-code
`);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
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
    const mockCwd = "/repo";

    beforeEach(() => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return mockCwd;
        }
        return Buffer.from("");
      });
      vi.spyOn(process, "cwd").mockReturnValue(mockCwd);
      vi.mocked(config.getToken).mockResolvedValue("test-token");
      vi.mocked(existsSync).mockImplementation((path) => {
        if (path === "vm0.yaml") return true;
        return false;
      });
      vi.mocked(fs.readFile).mockResolvedValue(`
version: "1.0"
agents:
  my-agent:
    provider: claude-code
`);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
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
    const mockGitRoot = "/repo";
    const mockSubdir = "/repo/.vm0";

    beforeEach(() => {
      // Mock git root at /repo, cwd at /repo/.vm0 (subdirectory)
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return mockGitRoot;
        }
        return Buffer.from("");
      });
      vi.spyOn(process, "cwd").mockReturnValue(mockSubdir);
      vi.mocked(config.getToken).mockResolvedValue("test-token");
      vi.mocked(existsSync).mockImplementation((path) => {
        if (path === "vm0.yaml") return true;
        return false;
      });
      vi.mocked(fs.readFile).mockResolvedValue(`
version: "1.0"
agents:
  subdir-agent:
    provider: claude-code
    instructions: AGENTS.md
`);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
      } as SpawnSyncReturns<Buffer>);
    });

    it("should include working-directory in publish.yml when run from subdirectory", async () => {
      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => String(call[0]).includes("publish.yml"));
      expect(writeCall).toBeDefined();
      const content = writeCall![1] as string;

      expect(content).toContain("working-directory: .vm0");
      expect(content).toContain("'.vm0/vm0.yaml'");
      expect(content).toContain("'.vm0/AGENTS.md'");
    });

    it("should write workflow files to git root .github directory", async () => {
      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      expect(fs.mkdir).toHaveBeenCalledWith("/repo/.github/workflows", {
        recursive: true,
      });
      expect(fs.writeFile).toHaveBeenCalledWith(
        "/repo/.github/workflows/publish.yml",
        expect.any(String),
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        "/repo/.github/workflows/run.yml",
        expect.any(String),
      );
    });

    it("should NOT include working-directory in run.yml (run-action does not need it)", async () => {
      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => String(call[0]).includes("run.yml"));
      expect(writeCall).toBeDefined();
      const content = writeCall![1] as string;

      expect(content).not.toContain("working-directory");
    });
  });

  describe("git root execution (no subdirectory)", () => {
    const mockCwd = "/repo";

    beforeEach(() => {
      // Mock git root and cwd both at /repo (at git root)
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return mockCwd;
        }
        return Buffer.from("");
      });
      vi.spyOn(process, "cwd").mockReturnValue(mockCwd);
      vi.mocked(config.getToken).mockResolvedValue("test-token");
      vi.mocked(existsSync).mockImplementation((path) => {
        if (path === "vm0.yaml") return true;
        return false;
      });
      vi.mocked(fs.readFile).mockResolvedValue(`
version: "1.0"
agents:
  root-agent:
    provider: claude-code
    instructions: AGENTS.md
`);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
      } as SpawnSyncReturns<Buffer>);
    });

    it("should NOT include working-directory when run from git root", async () => {
      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => String(call[0]).includes("publish.yml"));
      expect(writeCall).toBeDefined();
      const content = writeCall![1] as string;

      expect(content).not.toContain("working-directory");
      expect(content).toContain("'vm0.yaml'");
      expect(content).toContain("'AGENTS.md'");
    });
  });

  describe("nested subdirectory execution", () => {
    const mockGitRoot = "/repo";
    const mockNestedSubdir = "/repo/configs/agents";

    beforeEach(() => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "git rev-parse --show-toplevel") {
          return mockGitRoot;
        }
        return Buffer.from("");
      });
      vi.spyOn(process, "cwd").mockReturnValue(mockNestedSubdir);
      vi.mocked(config.getToken).mockResolvedValue("test-token");
      vi.mocked(existsSync).mockImplementation((path) => {
        if (path === "vm0.yaml") return true;
        return false;
      });
      vi.mocked(fs.readFile).mockResolvedValue(`
version: "1.0"
agents:
  nested-agent:
    provider: claude-code
    instructions: AGENTS.md
`);
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      vi.mocked(spawnSync).mockReturnValue({
        status: 0,
      } as SpawnSyncReturns<Buffer>);
    });

    it("should handle nested subdirectory paths correctly", async () => {
      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => String(call[0]).includes("publish.yml"));
      expect(writeCall).toBeDefined();
      const content = writeCall![1] as string;

      expect(content).toContain("working-directory: configs/agents");
      expect(content).toContain("'configs/agents/vm0.yaml'");
      expect(content).toContain("'configs/agents/AGENTS.md'");
    });
  });
});
