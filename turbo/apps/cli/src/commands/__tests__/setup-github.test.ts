import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupGithubCommand } from "../setup-github";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import * as readline from "readline";
import { execSync, spawnSync, SpawnSyncReturns } from "child_process";
import * as config from "../../lib/config";
import * as core from "@vm0/core";

// Mock dependencies
vi.mock("fs/promises");
vi.mock("fs");
vi.mock("readline");
vi.mock("child_process");
vi.mock("../../lib/config");
vi.mock("@vm0/core");

describe("setup-github command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  // Mock readline interface
  const mockRlQuestion = vi.fn();
  const mockRlClose = vi.fn();
  const mockRlInterface = {
    question: mockRlQuestion,
    close: mockRlClose,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readline.createInterface).mockReturnValue(
      mockRlInterface as unknown as readline.Interface,
    );
    // Default mocks for core functions
    vi.mocked(core.extractVariableReferences).mockReturnValue([]);
    vi.mocked(core.groupVariablesBySource).mockReturnValue({
      env: [],
      vars: [],
      secrets: [],
    });
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
  });

  describe("prerequisite checks", () => {
    it("should exit with error if gh CLI is not installed", async () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
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
      vi.mocked(execSync).mockReturnValue(Buffer.from(""));
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
      vi.mocked(execSync).mockReturnValue(Buffer.from(""));
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
    beforeEach(() => {
      // Pass all prerequisites
      vi.mocked(execSync).mockReturnValue(Buffer.from(""));
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
      mockRlQuestion.mockImplementation((_, callback) => {
        callback("n"); // Skip auto-setup
      });

      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => call[0] === ".github/workflows/publish.yml");
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
      mockRlQuestion.mockImplementation((_, callback) => {
        callback("n");
      });

      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => call[0] === ".github/workflows/run.yml");
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
      });

      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => call[0] === ".github/workflows/run.yml");
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
      });

      await setupGithubCommand.parseAsync(["node", "cli", "--skip-secrets"]);

      const writeCall = vi
        .mocked(fs.writeFile)
        .mock.calls.find((call) => call[0] === ".github/workflows/run.yml");
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
        .mock.calls.find((call) => call[0] === ".github/workflows/run.yml");
      expect(writeCall).toBeDefined();
      const content = writeCall![1] as string;

      expect(content).toContain("CUSTOM_SECRET=${{ secrets.CUSTOM_SECRET }}");
      expect(content).toContain("CUSTOM_VAR=${{ vars.CUSTOM_VAR }}");
    });
  });

  describe("existing file handling", () => {
    beforeEach(() => {
      vi.mocked(execSync).mockReturnValue(Buffer.from(""));
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
        if (path === ".github/workflows/publish.yml") return true;
        return false;
      });

      mockRlQuestion.mockImplementation((question, callback) => {
        if (question.includes("Overwrite")) {
          callback("n"); // No, don't overwrite
        } else {
          callback("n");
        }
      });

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
        if (path === ".github/workflows/publish.yml") return true;
        return false;
      });

      await setupGithubCommand.parseAsync([
        "node",
        "cli",
        "--force",
        "--skip-secrets",
      ]);

      expect(fs.writeFile).toHaveBeenCalledWith(
        ".github/workflows/publish.yml",
        expect.any(String),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Overwrote"),
      );
    });

    it("should work with -f short option", async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        if (path === "vm0.yaml") return true;
        if (path === ".github/workflows/publish.yml") return true;
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
    beforeEach(() => {
      vi.mocked(execSync).mockReturnValue(Buffer.from(""));
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
    beforeEach(() => {
      vi.mocked(execSync).mockReturnValue(Buffer.from(""));
      vi.mocked(config.getToken).mockResolvedValue("test-token");
      vi.mocked(existsSync).mockImplementation((path) => {
        if (path === "vm0.yaml") return true;
        if (path === ".github/workflows/publish.yml") return true;
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
      expect(mockRlQuestion).not.toHaveBeenCalled();
      // Should have proceeded with overwriting and setting secrets
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it("should work with -y short option", async () => {
      await setupGithubCommand.parseAsync(["node", "cli", "-y"]);

      expect(mockRlQuestion).not.toHaveBeenCalled();
      expect(fs.writeFile).toHaveBeenCalled();
    });
  });

  describe("secrets setup", () => {
    beforeEach(() => {
      vi.mocked(execSync).mockReturnValue(Buffer.from(""));
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
      const originalEnv = process.env[TEST_SECRET];
      process.env[TEST_SECRET] = "test-secret-value";

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

      process.env[TEST_SECRET] = originalEnv;
    });

    it("should show manual setup instructions when declining auto-setup", async () => {
      mockRlQuestion.mockImplementation((question, callback) => {
        if (question.includes("Set up GitHub secrets")) {
          callback("n"); // No, don't auto-setup
        } else {
          callback("");
        }
      });

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
    beforeEach(() => {
      vi.mocked(execSync).mockReturnValue(Buffer.from(""));
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
      });

      await setupGithubCommand.parseAsync(["node", "cli", "--yes"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Setup partially complete"),
      );
    });
  });
});
