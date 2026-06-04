import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { createMockChildProcess } from "../../../mocks/spawn-helpers";
import { composeCommand, getSecretsFromComposeContent } from "../index";
import * as fs from "fs/promises";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "fs";
import * as path from "path";
import * as os from "os";
import * as yaml from "yaml";
import chalk from "chalk";

// Configurable handler called when execFile encounters a "git checkout" command.
// Tests set this to populate the working directory with expected files.
let onGitCheckout: ((cwd: string) => void) | undefined;

// Mock child_process — the true external boundary for both spawn and execFile.
// spawn is used by silentUpgradeAfterCommand; execFile is used by git-client for git operations.
vi.mock("child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("child_process")>();
  return {
    ...original,
    spawn: vi.fn(),
    execFile: vi.fn(
      (
        file: string,
        args: string[],
        optionsOrCallback: unknown,
        maybeCallback?: unknown,
      ): { pid: number } => {
        const callback =
          typeof optionsOrCallback === "function"
            ? (optionsOrCallback as (
                err: Error | null,
                result: { stdout: string; stderr: string },
              ) => void)
            : (maybeCallback as (
                err: Error | null,
                result: { stdout: string; stderr: string },
              ) => void);
        const options =
          typeof optionsOrCallback === "object"
            ? (optionsOrCallback as { cwd?: string })
            : undefined;
        const cwd = options?.cwd;
        const cmd = [file, ...args].join(" ");

        // git init: create .git/info/ so sparse-checkout file writes succeed
        if (cmd.startsWith("git init") && cwd) {
          mkdirSync(path.join(cwd, ".git", "info"), { recursive: true });
        }

        // git checkout: populate the working directory via test-provided handler
        if (cmd.startsWith("git checkout") && cwd && onGitCheckout) {
          onGitCheckout(cwd);
        }

        // git ls-remote: return a fake default branch reference
        if (cmd.includes("git ls-remote")) {
          callback(null, {
            stdout: "ref: refs/heads/main\tHEAD\n",
            stderr: "",
          });
          return { pid: 0 };
        }

        callback(null, { stdout: "", stderr: "" });
        return { pid: 0 };
      },
    ),
  };
});

import { spawn, execFile } from "child_process";
const mockSpawn = vi.mocked(spawn);
const mockExecFile = vi.mocked(execFile);

// Shared spies at file level
const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
  throw new Error("process.exit called");
}) as never);
const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
const mockConsoleError = vi
  .spyOn(console, "error")
  .mockImplementation(() => {});

describe("compose command", () => {
  let tempDir: string;
  let originalCwd: string;

  const orgResponse = {
    id: "org-123",
    slug: "user-abc12345",
    displayName: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-compose-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
    chalk.level = 0;
    onGitCheckout = undefined;

    // Default npm registry handler - return same version to skip upgrade
    // This prevents silentUpgradeAfterCommand from attempting real upgrades
    server.use(
      http.get("https://registry.npmjs.org/*/latest", () => {
        return HttpResponse.json({ version: "0.0.0-test" });
      }),
    );

    // Default spawn mock - succeeds immediately
    // This is needed because silentUpgradeAfterCommand uses spawn
    mockSpawn.mockImplementation(() => {
      return createMockChildProcess(0) as never;
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("file validation", () => {
    it("should exit with error if file does not exist", async () => {
      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "nonexistent.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Config file not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should read file when it exists", async () => {
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        `version: "1.0"\nagents:\n  test:\n    framework: claude-code`,
      );
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test",
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
            action: "created",
          });
        }),
        http.get("http://localhost:3000/api/zero/org", () => {
          return HttpResponse.json(orgResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "config.yaml"]);

      const content = await fs.readFile(
        path.join(tempDir, "config.yaml"),
        "utf8",
      );
      expect(content).toContain("version");
    });

    it("should use vm0.yaml by default when no argument provided", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"\nagents:\n  test:\n    framework: claude-code`,
      );
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test",
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
            action: "created",
          });
        }),
        http.get("http://localhost:3000/api/zero/org", () => {
          return HttpResponse.json(orgResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose created"),
      );
    });

    it("should show error when vm0.yaml not found and no argument provided", async () => {
      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Config file not found: vm0.yaml"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should use explicit file path when provided", async () => {
      // Create both files to verify explicit takes precedence
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"\nagents:\n  default-agent:\n    framework: claude-code`,
      );
      await fs.writeFile(
        path.join(tempDir, "custom.yaml"),
        `version: "1.0"\nagents:\n  custom-agent:\n    framework: claude-code`,
      );

      let capturedBody: unknown;
      server.use(
        http.post(
          "http://localhost:3000/api/agent/composes",
          async ({ request }) => {
            capturedBody = await request.json();
            return HttpResponse.json({
              composeId: "cmp-123",
              name: "custom-agent",
              versionId:
                "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
              action: "created",
            });
          },
        ),
        http.get("http://localhost:3000/api/zero/org", () => {
          return HttpResponse.json(orgResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "custom.yaml"]);

      expect(capturedBody).toMatchObject({
        content: {
          agents: {
            "custom-agent": expect.any(Object),
          },
        },
      });
    });
  });

  describe("YAML parsing", () => {
    it("should exit with error on invalid YAML", async () => {
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        "invalid: yaml: content:",
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid YAML format"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should parse valid YAML", async () => {
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        `version: "1.0"\nagents:\n  test:\n    framework: claude-code`,
      );
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test",
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
            action: "created",
          });
        }),
        http.get("http://localhost:3000/api/zero/org", () => {
          return HttpResponse.json(orgResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "config.yaml"]);

      const content = await fs.readFile(
        path.join(tempDir, "config.yaml"),
        "utf8",
      );
      const parsed = yaml.parse(content);
      expect(parsed.version).toBe("1.0");
    });
  });

  describe("compose validation", () => {
    it("should exit with error on invalid compose (missing agents)", async () => {
      // Create YAML without agents section to trigger real validation error
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        `version: "1.0"\n# no agents defined`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Missing agents"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error on invalid agent name", async () => {
      // Create YAML with invalid agent name (too short)
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        `version: "1.0"\nagents:\n  ab:\n    framework: claude-code`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid agent name"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should proceed with valid compose", async () => {
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        `version: "1.0"\nagents:\n  test:\n    framework: claude-code`,
      );
      let composeApiCalled = false;
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          composeApiCalled = true;
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test",
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
            action: "created",
          });
        }),
        http.get("http://localhost:3000/api/zero/org", () => {
          return HttpResponse.json(orgResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(composeApiCalled).toBe(true);
    });
  });

  describe("field typo detection", () => {
    it("should detect plural typo 'environments' and suggest 'environment'", async () => {
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framework: anthropic\n    environments:\n      MY_VAR: foo`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Did you mean "environment"'),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should detect singular typo 'volume' and suggest 'volumes'", async () => {
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framework: anthropic\n    volume:\n      - data:/data`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Did you mean "volumes"'),
      );
    });

    it("should detect singular typo 'skill' and suggest 'skills'", async () => {
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framework: anthropic\n    skill:\n      - https://github.com/org/repo/tree/main/path`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Did you mean "skills"'),
      );
    });

    it("should detect misspelling 'framwork' and suggest 'framework'", async () => {
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framwork: anthropic`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Did you mean "framework"'),
      );
    });

    it("should detect abbreviation 'env' and suggest 'environment'", async () => {
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framework: anthropic\n    env:\n      MY_VAR: foo`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Did you mean "environment"'),
      );
    });

    it("should detect abbreviation 'desc' and suggest 'description'", async () => {
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framework: anthropic\n    desc: my agent`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Did you mean "description"'),
      );
    });

    it("should allow unknown fields that do not resemble known fields", async () => {
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framework: claude-code\n    foobar: something`,
      );
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test-agent",
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
            action: "created",
          });
        }),
        http.get("http://localhost:3000/api/zero/org", () => {
          return HttpResponse.json(orgResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "config.yaml"]);

      // Should not have exited with error
      expect(mockConsoleError).not.toHaveBeenCalledWith(
        expect.stringContaining("Did you mean"),
      );
    });

    it("should report multiple typos at once", async () => {
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framework: anthropic\n    environments:\n      MY_VAR: foo\n    skill:\n      - https://github.com/org/repo/tree/main/path`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Did you mean "environment"'),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining('Did you mean "skills"'),
      );
    });

    it("should not flag valid 'environment' field as typo", async () => {
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framework: claude-code\n    environment:\n      MY_VAR: foo`,
      );
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test-agent",
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
            action: "created",
          });
        }),
        http.get("http://localhost:3000/api/zero/org", () => {
          return HttpResponse.json(orgResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(mockConsoleError).not.toHaveBeenCalledWith(
        expect.stringContaining("Did you mean"),
      );
    });
  });

  describe("API interaction", () => {
    beforeEach(async () => {
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        `version: "1.0"\nagents:\n  test:\n    framework: claude-code`,
      );
    });

    it("should display loading message", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test",
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
            action: "created",
          });
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Uploading compose"),
      );
    });

    it("should display created message", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test-agent",
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
            action: "created",
          });
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose created: test-agent"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Version: a1b2c3d4"),
      );
    });

    it("should display 'version exists' message", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test-agent",
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
            action: "existing",
          });
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose version exists: test-agent"),
      );
    });

    it("should display usage instructions", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test",
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
            action: "created",
          });
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("vm0 run test"),
      );
    });
  });

  describe("error handling", () => {
    beforeEach(async () => {
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        `version: "1.0"\nagents:\n  test:\n    framework: claude-code`,
      );
    });

    it("should handle authentication errors", async () => {
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
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
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Failed to create compose: Invalid name",
                code: "INVALID_NAME",
              },
            },
            { status: 400 },
          );
        }),
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
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.error();
        }),
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "config.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("framework validation", () => {
    it("should reject unsupported framework client-side", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    description: "Test agent with unsupported framework"
    framework: unsupported-framework`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("agent.framework"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid option"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should accept supported framework", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    description: "Test agent with supported framework"
    framework: claude-code`,
      );

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test-agent",
            versionId: "a1b2c3d4e5f6g7h8" + "0".repeat(48),
            action: "created",
          });
        }),
        http.get("http://localhost:3000/api/zero/org", () => {
          return HttpResponse.json(orgResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose"),
      );
    });
  });

  describe("instructions validation", () => {
    it("should reject empty instructions string", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    framework: claude-code
    instructions: ""`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("empty"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should fail when instructions file does not exist", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    framework: claude-code
    instructions: nonexistent-file.md`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("runner group validation", () => {
    it("should accept valid runner group format (vm0/<name>)", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  valid-runner-agent:
    description: "Test agent with valid runner group"
    framework: claude-code
    experimental_runner:
      group: vm0/production`,
      );

      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "valid-runner-agent",
            versionId: "a1b2c3d4e5f6g7h8" + "0".repeat(48),
            action: "created",
          });
        }),
        http.get("http://localhost:3000/api/zero/org", () => {
          return HttpResponse.json(orgResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose"),
      );
    });

    it("should reject invalid runner group format (missing slash)", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  invalid-runner-agent:
    description: "Test agent with invalid runner group"
    framework: claude-code
    experimental_runner:
      group: invalid-no-slash`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
      }).rejects.toThrow("process.exit called");

      const allErrors = mockConsoleError.mock.calls.map((call) => {
        return call[0] as string;
      });
      const hasFormatError = allErrors.some((err) => {
        return err.includes("vm0/") || err.includes("format");
      });
      expect(hasFormatError).toBe(true);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it.each(["org/team", "my-org/my-runner", "company123/prod-runner", "a/b"])(
      "should accept valid runner group format: %s",
      async (group) => {
        await fs.writeFile(
          path.join(tempDir, "vm0.yaml"),
          `version: "1.0"
agents:
  test-agent:
    description: "Test agent"
    framework: claude-code
    experimental_runner:
      group: ${group}`,
        );

        server.use(
          http.post("http://localhost:3000/api/agent/composes", () => {
            return HttpResponse.json({
              composeId: "cmp-123",
              name: "test-agent",
              versionId: "a1b2c3d4e5f6g7h8" + "0".repeat(48),
              action: "created",
            });
          }),
          http.get("http://localhost:3000/api/zero/org", () => {
            return HttpResponse.json(orgResponse);
          }),
        );

        await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
        expect(mockConsoleLog).toHaveBeenCalledWith(
          expect.stringContaining("Compose"),
        );
      },
    );

    it.each([
      "no-slash",
      "too/many/slashes",
      "UPPERCASE/invalid",
      "/leading-slash",
      "trailing-slash/",
    ])("should reject invalid runner group format: %s", async (group) => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    description: "Test agent"
    framework: claude-code
    experimental_runner:
      group: ${group}`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("versioning", () => {
    it("should display version ID in 8-character hex format", async () => {
      const fullVersionId =
        "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    description: "Test agent for version display"
    framework: claude-code`,
      );

      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test-agent",
            versionId: fullVersionId,
            action: "created",
          });
        }),
        http.get("http://localhost:3000/api/zero/org", () => {
          return HttpResponse.json(orgResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      const allLogs = mockConsoleLog.mock.calls
        .map((call) => {
          return call[0];
        })
        .filter((log): log is string => {
          return typeof log === "string";
        });
      const versionLog = allLogs.find((log) => {
        return log.includes("Version:");
      });
      expect(versionLog).toBeDefined();
      expect(versionLog).toContain("a1b2c3d4");
      expect(versionLog).not.toContain(fullVersionId);
    });

    it("should display version ID in run command hint", async () => {
      const fullVersionId =
        "deadbeef12345678deadbeef12345678deadbeef12345678deadbeef12345678";
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  my-agent:
    framework: claude-code`,
      );

      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-456",
            name: "my-agent",
            versionId: fullVersionId,
            action: "created",
          });
        }),
        http.get("http://localhost:3000/api/zero/org", () => {
          return HttpResponse.json(orgResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      const allLogs = mockConsoleLog.mock.calls
        .map((call) => {
          return call[0];
        })
        .filter((log): log is string => {
          return typeof log === "string";
        });
      const runHint = allLogs.find((log) => {
        return log.includes("vm0 run");
      });
      expect(runHint).toBeDefined();
      expect(runHint).toContain(":deadbeef");
    });
  });

  describe("parallel auto-upgrade", () => {
    const originalArgv = process.argv;

    beforeEach(async () => {
      // Set up npm path to enable auto-upgrade
      process.argv = ["/usr/bin/node", "/usr/local/bin/vm0"];

      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    framework: claude-code`,
      );

      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test-agent",
            versionId: "a".repeat(64),
            action: "created",
          });
        }),
        http.get("http://localhost:3000/api/zero/org", () => {
          return HttpResponse.json(orgResponse);
        }),
      );
    });

    afterEach(() => {
      process.argv = originalArgv;
      mockSpawn.mockReset();
    });

    it("should not attempt upgrade with --no-auto-update flag", async () => {
      // Mock npm registry returns newer version
      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.json({ version: "99.0.0" });
        }),
      );

      // Mock spawn - use mockImplementation to create fresh EventEmitter each call
      mockSpawn.mockImplementation(() => {
        return createMockChildProcess(0) as never;
      });

      await composeCommand.parseAsync([
        "node",
        "cli",
        "vm0.yaml",
        "--no-auto-update",
      ]);

      // With --no-auto-update, spawn should not be called
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("should call spawn with npm install when auto-upgrade enabled", async () => {
      // Mock npm registry returns newer version
      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.json({ version: "99.0.0" });
        }),
      );

      // Mock spawn - use mockImplementation to create fresh EventEmitter each call
      mockSpawn.mockImplementation(() => {
        return createMockChildProcess(0) as never;
      });

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      // spawn should be called with npm install
      expect(mockSpawn).toHaveBeenCalledWith(
        "npm",
        ["install", "-g", "@vm0/cli@latest"],
        expect.objectContaining({
          stdio: "pipe",
        }),
      );
    });

    it("should not show whisper when upgrade succeeds", async () => {
      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.json({ version: "99.0.0" });
        }),
      );

      // Mock spawn to return success (exit code 0)
      // Use mockImplementation to create fresh EventEmitter each call
      mockSpawn.mockImplementation(() => {
        return createMockChildProcess(0) as never;
      });

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      // No whisper message should appear
      const allLogs = mockConsoleLog.mock.calls
        .map((call) => {
          return call[0];
        })
        .filter((log): log is string => {
          return typeof log === "string";
        });
      expect(
        allLogs.some((log) => {
          return log.includes("auto upgrade failed");
        }),
      ).toBe(false);
    });

    it("should show whisper when upgrade fails", async () => {
      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.json({ version: "99.0.0" });
        }),
      );

      // Mock spawn to return failure (exit code 1)
      // Use mockImplementation to create fresh EventEmitter each call
      mockSpawn.mockImplementation(() => {
        return createMockChildProcess(1) as never;
      });

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      // Whisper message should appear
      const allLogs = mockConsoleLog.mock.calls
        .map((call) => {
          return call[0];
        })
        .filter((log): log is string => {
          return typeof log === "string";
        });
      expect(
        allLogs.some((log) => {
          return log.includes("auto upgrade failed");
        }),
      ).toBe(true);
      expect(
        allLogs.some((log) => {
          return log.includes("npm install -g @vm0/cli@latest");
        }),
      ).toBe(true);
    });

    it("should not attempt upgrade when already on latest version", async () => {
      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          // Return same version as current (simulated by CLI_VERSION)
          return HttpResponse.json({ version: "0.0.0-test" });
        }),
      );

      mockSpawn.mockImplementation(() => {
        return createMockChildProcess(0) as never;
      });

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      // spawn should not be called when already on latest
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("should not attempt upgrade for unsupported package manager (bun)", async () => {
      // Set bun path
      process.argv = ["/usr/bin/node", "/home/user/.bun/bin/vm0"];

      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.json({ version: "99.0.0" });
        }),
      );

      mockSpawn.mockImplementation(() => {
        return createMockChildProcess(0) as never;
      });

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      // spawn should not be called for bun
      expect(mockSpawn).not.toHaveBeenCalled();

      // No whisper for unsupported PM
      const allLogs = mockConsoleLog.mock.calls
        .map((call) => {
          return call[0];
        })
        .filter((log): log is string => {
          return typeof log === "string";
        });
      expect(
        allLogs.some((log) => {
          return log.includes("auto upgrade failed");
        }),
      ).toBe(false);
    });

    it("should use pnpm when installed via pnpm", async () => {
      // Set pnpm path
      process.argv = ["/usr/bin/node", "/home/user/.local/share/pnpm/vm0"];

      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.json({ version: "99.0.0" });
        }),
      );

      mockSpawn.mockImplementation(() => {
        return createMockChildProcess(0) as never;
      });

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      // spawn should be called with pnpm add
      expect(mockSpawn).toHaveBeenCalledWith(
        "pnpm",
        ["add", "-g", "@vm0/cli@latest"],
        expect.objectContaining({
          stdio: "pipe",
        }),
      );
    });
  });

  describe("--json option", () => {
    it("should output JSON result on success", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framework: claude-code`,
      );
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test-agent",
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
            action: "created",
          });
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "--json"]);

      // Find the JSON output call
      const jsonOutputCall = mockConsoleLog.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0] as string);
          return parsed.composeId !== undefined;
        } catch {
          return false;
        }
      });

      expect(jsonOutputCall).toBeDefined();
      const result = JSON.parse(jsonOutputCall![0] as string);
      expect(result).toMatchObject({
        composeId: "cmp-123",
        composeName: "test-agent",
        versionId:
          "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
        action: "created",
        displayName: "test-agent",
      });
    });

    it("should suppress intermediate output in JSON mode", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framework: claude-code`,
      );
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test-agent",
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
            action: "created",
          });
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "--json"]);

      // Should not have "Uploading compose..." or "Compose created:" messages
      const allLogs = mockConsoleLog.mock.calls
        .map((call) => {
          return call[0];
        })
        .filter((log): log is string => {
          return typeof log === "string";
        });

      expect(
        allLogs.some((log) => {
          return log.includes("Uploading compose");
        }),
      ).toBe(false);
      expect(
        allLogs.some((log) => {
          return log.includes("Compose created:");
        }),
      ).toBe(false);
      expect(
        allLogs.some((log) => {
          return log.includes("Run your agent");
        }),
      ).toBe(false);
    });

    it("should output JSON error on failure", async () => {
      // No vm0.yaml file exists
      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "--json"]);
      }).rejects.toThrow("process.exit called");

      // Find the JSON error output
      const jsonOutputCall = mockConsoleLog.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0] as string);
          return parsed.error !== undefined;
        } catch {
          return false;
        }
      });

      expect(jsonOutputCall).toBeDefined();
      const result = JSON.parse(jsonOutputCall![0] as string);
      expect(result.error).toContain("Config file not found");
    });

    it("should imply --yes flag in JSON mode", async () => {
      // Simple test: verify --json mode sets options.yes = true internally
      // by checking that no confirmation prompts appear in JSON output
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framework: claude-code`,
      );
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test-agent",
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
            action: "created",
          });
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "--json"]);

      // No prompt-related output should appear
      const allLogs = mockConsoleLog.mock.calls
        .map((call) => {
          return call[0];
        })
        .filter((log): log is string => {
          return typeof log === "string";
        });

      expect(
        allLogs.some((log) => {
          return log.includes("confirm");
        }),
      ).toBe(false);
      expect(
        allLogs.some((log) => {
          return log.includes("Approve");
        }),
      ).toBe(false);
    });

    it("should not call checkMissingItems in --json mode", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framework: claude-code`,
      );

      let secretsCalled = false;
      let variablesCalled = false;
      let connectorsCalled = false;

      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test-agent",
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
            action: "created",
          });
        }),
        http.get("http://localhost:3000/api/zero/secrets", () => {
          secretsCalled = true;
          return HttpResponse.json({ secrets: [] });
        }),
        http.get("http://localhost:3000/api/zero/variables", () => {
          variablesCalled = true;
          return HttpResponse.json({ variables: [] });
        }),
        http.get("http://localhost:3000/api/zero/connectors", () => {
          connectorsCalled = true;
          return HttpResponse.json({
            connectors: [],
            configuredTypes: [],
            connectorProvidedBindings: [],
          });
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "--json"]);

      expect(secretsCalled).toBe(false);
      expect(variablesCalled).toBe(false);
      expect(connectorsCalled).toBe(false);
    });

    it("should skip auto-update in JSON mode", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framework: claude-code`,
      );

      // Set up a newer version available
      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.json({ version: "99.0.0" });
        }),
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test-agent",
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
            action: "created",
          });
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "--json"]);

      // spawn should NOT be called for auto-update in JSON mode
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("should show deprecation warning for --porcelain", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framework: claude-code`,
      );
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test-agent",
            versionId:
              "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
            action: "created",
          });
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "--porcelain"]);

      // Should show deprecation warning
      const errorCalls = mockConsoleError.mock.calls
        .map((call) => {
          return call[0];
        })
        .filter((log): log is string => {
          return typeof log === "string";
        });

      expect(
        errorCalls.some((log) => {
          return log.includes("--porcelain is deprecated");
        }),
      ).toBe(true);
    });
  });

  describe("legacy skills field", () => {
    it("accepts the field in YAML but strips it from the posted compose content", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  my-agent:
    framework: claude-code
    skills:
      - slack
      - https://github.com/acme/repo/tree/main/tool`,
      );

      let capturedBody: unknown;
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.post(
          "http://localhost:3000/api/agent/composes",
          async ({ request }) => {
            capturedBody = await request.json();
            return HttpResponse.json({
              composeId: "cmp-123",
              name: "my-agent",
              versionId: "a".repeat(64),
              action: "created",
            });
          },
        ),
        http.get("http://localhost:3000/api/zero/org", () => {
          return HttpResponse.json(orgResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml", "--yes"]);

      const body = capturedBody as {
        content: { agents: Record<string, Record<string, unknown>> };
      };
      expect(body.content.agents["my-agent"]).toBeDefined();
      expect(body.content.agents["my-agent"]).not.toHaveProperty("skills");
    });
  });
});

describe("GitHub URL compose", () => {
  let tempDir: string;
  let originalCwd: string;

  const orgResponse = {
    id: "org-123",
    slug: "user-abc12345",
    displayName: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };

  /**
   * Helper to create a mock GitHub cookbook directory with vm0.yaml.
   */
  function createMockCookbookDir(
    parentDir: string,
    subPath: string,
    vm0YamlContent: string,
  ): string {
    const cookbookDir = path.join(parentDir, subPath);
    mkdirSync(cookbookDir, { recursive: true });
    writeFileSync(path.join(cookbookDir, "vm0.yaml"), vm0YamlContent);
    return cookbookDir;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-github-compose-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
    chalk.level = 0;
    onGitCheckout = undefined;

    // Default npm registry handler
    server.use(
      http.get("https://registry.npmjs.org/*/latest", () => {
        return HttpResponse.json({ version: "0.0.0-test" });
      }),
    );

    // Default spawn mock
    mockSpawn.mockImplementation(() => {
      return createMockChildProcess(0) as never;
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should accept deprecated --experimental-shared-compose flag without error", async () => {
    // Configure git checkout to populate the working directory with vm0.yaml
    onGitCheckout = (cwd) => {
      createMockCookbookDir(
        cwd,
        "tutorials/101-intro",
        `version: "1.0"
agents:
  intro:
    framework: claude-code`,
      );
    };

    // Setup API mocks
    server.use(
      http.get("http://localhost:3000/api/agent/composes", () => {
        return HttpResponse.json(
          { error: { message: "Not found", code: "NOT_FOUND" } },
          { status: 404 },
        );
      }),
      http.post("http://localhost:3000/api/agent/composes", () => {
        return HttpResponse.json({
          composeId: "cmp-123",
          name: "intro",
          versionId: "a".repeat(64),
          action: "created",
        });
      }),
      http.get("http://localhost:3000/api/zero/org", () => {
        return HttpResponse.json(orgResponse);
      }),
    );

    // Should work WITH the deprecated flag (backward compatibility)
    await composeCommand.parseAsync([
      "node",
      "cli",
      "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
      "--experimental-shared-compose",
    ]);

    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Compose created"),
    );
  });

  it("should error when vm0.yaml not found in GitHub directory", async () => {
    // Configure git checkout to create directory without vm0.yaml
    onGitCheckout = (cwd) => {
      mkdirSync(path.join(cwd, "tutorials/101-intro"), { recursive: true });
    };

    await expect(async () => {
      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("vm0.yaml not found"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should error when compose has volumes", async () => {
    // Configure git checkout to populate directory with vm0.yaml containing volumes
    onGitCheckout = (cwd) => {
      createMockCookbookDir(
        cwd,
        "tutorials/104-intro-volume",
        `version: "1.0"
agents:
  intro-volume:
    framework: claude-code
    volumes:
      - claude-files:/home/user/.claude

volumes:
  claude-files:
    name: claude-files
    version: latest`,
      );
    };

    await expect(async () => {
      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/104-intro-volume",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "Volumes are not supported for GitHub URL compose",
      ),
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Clone the repository locally"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should successfully compose from GitHub URL with flag", async () => {
    // Configure git checkout to populate directory with valid cookbook
    onGitCheckout = (cwd) => {
      createMockCookbookDir(
        cwd,
        "tutorials/101-intro",
        `version: "1.0"
agents:
  intro:
    framework: claude-code`,
      );
    };

    server.use(
      http.get("http://localhost:3000/api/agent/composes", () => {
        return HttpResponse.json(
          { error: { message: "Not found", code: "NOT_FOUND" } },
          { status: 404 },
        );
      }),
      http.post("http://localhost:3000/api/agent/composes", () => {
        return HttpResponse.json({
          composeId: "cmp-123",
          name: "intro",
          versionId: "a".repeat(64),
          action: "created",
        });
      }),
    );

    await composeCommand.parseAsync([
      "node",
      "cli",
      "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
    ]);

    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Downloading from GitHub"),
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Compose created: intro"),
    );
  });

  it("should handle compose with instructions from GitHub URL", async () => {
    // Configure git checkout to populate directory with cookbook and instructions file
    onGitCheckout = (cwd) => {
      const cookbookDir = createMockCookbookDir(
        cwd,
        "tutorials/101-intro",
        `version: "1.0"
agents:
  intro:
    framework: claude-code
    instructions: AGENTS.md`,
      );
      writeFileSync(
        path.join(cookbookDir, "AGENTS.md"),
        "# Agent Instructions",
      );
    };

    server.use(
      http.post("http://localhost:3000/api/storages/prepare", () => {
        return HttpResponse.json({
          versionId: "a".repeat(64),
          existing: true,
        });
      }),
      http.post("http://localhost:3000/api/storages/commit", () => {
        return HttpResponse.json({
          success: true,
          versionId: "a".repeat(64),
          storageName: "test-storage",
          size: 1000,
          fileCount: 1,
          deduplicated: true,
        });
      }),
      http.get("http://localhost:3000/api/agent/composes", () => {
        return HttpResponse.json(
          { error: { message: "Not found", code: "NOT_FOUND" } },
          { status: 404 },
        );
      }),
      http.post("http://localhost:3000/api/agent/composes", () => {
        return HttpResponse.json({
          composeId: "cmp-123",
          name: "intro",
          versionId: "a".repeat(64),
          action: "created",
        });
      }),
      http.get("http://localhost:3000/api/zero/org", () => {
        return HttpResponse.json(orgResponse);
      }),
    );

    await composeCommand.parseAsync([
      "node",
      "cli",
      "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
    ]);

    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Uploading instructions"),
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Compose created"),
    );
  });

  it("should cleanup temp directory after successful compose", async () => {
    // Track the temp directory created by downloadGitHubDirectory
    let gitTempDir: string | undefined;
    onGitCheckout = (cwd) => {
      gitTempDir = cwd;
      createMockCookbookDir(
        cwd,
        "tutorials/101-intro",
        `version: "1.0"
agents:
  intro:
    framework: claude-code`,
      );
    };

    server.use(
      http.get("http://localhost:3000/api/agent/composes", () => {
        return HttpResponse.json(
          { error: { message: "Not found", code: "NOT_FOUND" } },
          { status: 404 },
        );
      }),
      http.post("http://localhost:3000/api/agent/composes", () => {
        return HttpResponse.json({
          composeId: "cmp-123",
          name: "intro",
          versionId: "a".repeat(64),
          action: "created",
        });
      }),
      http.get("http://localhost:3000/api/zero/org", () => {
        return HttpResponse.json(orgResponse);
      }),
    );

    await composeCommand.parseAsync([
      "node",
      "cli",
      "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
    ]);

    // The tempRoot should be fully cleaned up (including the .git folder)
    expect(gitTempDir).toBeDefined();
    expect(existsSync(gitTempDir!)).toBe(false);
  });

  it("should detect GitHub tree URLs correctly", async () => {
    // Non-GitHub URL should show "not found" error
    await expect(async () => {
      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Config file not found"),
    );
  });

  describe("repository root URL support", () => {
    it("should recognize plain repository URL as GitHub URL", async () => {
      // Root URL (no path) — vm0.yaml placed directly in checkout root
      onGitCheckout = (cwd) => {
        writeFileSync(
          path.join(cwd, "vm0.yaml"),
          `version: "1.0"
agents:
  test-agent:
    framework: claude-code`,
        );
      };

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test-agent",
            versionId: "a".repeat(64),
            action: "created",
          });
        }),
        http.get("http://localhost:3000/api/zero/org", () => {
          return HttpResponse.json(orgResponse);
        }),
      );

      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/owner/repo",
      ]);

      // Verify git operations targeted the correct repository
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining([expect.stringContaining("owner/repo.git")]),
        expect.anything(),
        expect.anything(),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Downloading from GitHub"),
      );
    });

    it("should recognize tree URL without path (root) as GitHub URL", async () => {
      // Root URL with explicit branch — vm0.yaml placed directly in checkout root
      onGitCheckout = (cwd) => {
        writeFileSync(
          path.join(cwd, "vm0.yaml"),
          `version: "1.0"
agents:
  test-agent:
    framework: claude-code`,
        );
      };

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test-agent",
            versionId: "a".repeat(64),
            action: "created",
          });
        }),
        http.get("http://localhost:3000/api/zero/org", () => {
          return HttpResponse.json(orgResponse);
        }),
      );

      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/owner/repo/tree/main",
      ]);

      // Verify git operations targeted the correct repository
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining([expect.stringContaining("owner/repo.git")]),
        expect.anything(),
        expect.anything(),
      );
    });

    it("should handle tree URL with trailing slash (root)", async () => {
      // Root URL with trailing slash — vm0.yaml placed directly in checkout root
      onGitCheckout = (cwd) => {
        writeFileSync(
          path.join(cwd, "vm0.yaml"),
          `version: "1.0"
agents:
  test-agent:
    framework: claude-code`,
        );
      };

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test-agent",
            versionId: "a".repeat(64),
            action: "created",
          });
        }),
        http.get("http://localhost:3000/api/zero/org", () => {
          return HttpResponse.json(orgResponse);
        }),
      );

      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/owner/repo/tree/main/",
      ]);

      // Verify git operations targeted the correct repository
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining([expect.stringContaining("owner/repo.git")]),
        expect.anything(),
        expect.anything(),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose created"),
      );
    });

    it("should handle tree URL with trailing slash (path)", async () => {
      // Subdirectory URL with trailing slash — vm0.yaml placed in subdirectory
      onGitCheckout = (cwd) => {
        createMockCookbookDir(
          cwd,
          "examples/101-intro",
          `version: "1.0"
agents:
  test-agent:
    framework: claude-code`,
        );
      };

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "test-agent",
            versionId: "a".repeat(64),
            action: "created",
          });
        }),
        http.get("http://localhost:3000/api/zero/org", () => {
          return HttpResponse.json(orgResponse);
        }),
      );

      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/owner/repo/tree/main/examples/101-intro/",
      ]);

      // Verify git operations targeted the correct repository
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining([expect.stringContaining("owner/repo.git")]),
        expect.anything(),
        expect.anything(),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose created"),
      );
    });
  });

  describe("existing agent overwrite confirmation", () => {
    it("should prompt for confirmation when agent already exists (non-interactive without --yes)", async () => {
      onGitCheckout = (cwd) => {
        createMockCookbookDir(
          cwd,
          "tutorials/101-intro",
          `version: "1.0"
agents:
  intro:
    framework: claude-code`,
        );
      };

      // Mock existing compose
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            id: "existing-compose-id",
            name: "intro",
            headVersionId: "c".repeat(64),
            content: {
              version: "1.0",
              agents: { intro: { framework: "claude-code" } },
            },
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          });
        }),
      );

      // Non-interactive mode
      vi.stubEnv("CI", "true");

      await expect(async () => {
        await composeCommand.parseAsync([
          "node",
          "cli",
          "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('An agent named "intro" already exists'),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Cannot overwrite existing agent in non-interactive mode",
        ),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--yes"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should allow overwrite with --yes flag when agent exists (non-interactive)", async () => {
      onGitCheckout = (cwd) => {
        createMockCookbookDir(
          cwd,
          "tutorials/101-intro",
          `version: "1.0"
agents:
  intro:
    framework: claude-code`,
        );
      };

      // Mock existing compose for the name check
      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            id: "existing-compose-id",
            name: "intro",
            headVersionId: "c".repeat(64),
            content: {
              version: "1.0",
              agents: { intro: { framework: "claude-code" } },
            },
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          });
        }),
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "intro",
            versionId: "a".repeat(64),
            action: "existing",
          });
        }),
        http.get("http://localhost:3000/api/zero/org", () => {
          return HttpResponse.json(orgResponse);
        }),
      );

      // Non-interactive mode
      vi.stubEnv("CI", "true");

      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
        "--yes",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining('An agent named "intro" already exists'),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose version exists"),
      );
    });

    it("should not prompt when agent does not exist", async () => {
      onGitCheckout = (cwd) => {
        createMockCookbookDir(
          cwd,
          "tutorials/101-intro",
          `version: "1.0"
agents:
  new-agent:
    framework: claude-code`,
        );
      };

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "new-agent",
            versionId: "a".repeat(64),
            action: "created",
          });
        }),
        http.get("http://localhost:3000/api/zero/org", () => {
          return HttpResponse.json(orgResponse);
        }),
      );

      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
      ]);

      // Should not show the "already exists" warning
      const allLogs = mockConsoleLog.mock.calls
        .map((call) => {
          return call[0];
        })
        .filter((log): log is string => {
          return typeof log === "string";
        });
      expect(
        allLogs.some((log) => {
          return log.includes("already exists");
        }),
      ).toBe(false);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose created"),
      );
    });
  });

  describe("--json option with GitHub URL", () => {
    it("should output JSON result for GitHub URL compose", async () => {
      onGitCheckout = (cwd) => {
        createMockCookbookDir(
          cwd,
          "tutorials/101-intro",
          `version: "1.0"
agents:
  intro:
    framework: claude-code`,
        );
      };

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-github-123",
            name: "intro",
            versionId: "b".repeat(64),
            action: "created",
          });
        }),
      );

      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
        "--json",
      ]);

      // Find the JSON output
      const jsonOutputCall = mockConsoleLog.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0] as string);
          return parsed.composeId !== undefined;
        } catch {
          return false;
        }
      });

      expect(jsonOutputCall).toBeDefined();
      const result = JSON.parse(jsonOutputCall![0] as string);
      expect(result).toMatchObject({
        composeId: "cmp-github-123",
        composeName: "intro",
        versionId: "b".repeat(64),
        action: "created",
        displayName: "intro",
      });
    });

    it("should suppress intermediate output for GitHub URL in JSON mode", async () => {
      onGitCheckout = (cwd) => {
        createMockCookbookDir(
          cwd,
          "tutorials/101-intro",
          `version: "1.0"
agents:
  intro:
    framework: claude-code`,
        );
      };

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-123",
            name: "intro",
            versionId: "a".repeat(64),
            action: "created",
          });
        }),
      );

      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
        "--json",
      ]);

      // Should not have "Downloading from GitHub..." message
      const allLogs = mockConsoleLog.mock.calls
        .map((call) => {
          return call[0];
        })
        .filter((log): log is string => {
          return typeof log === "string";
        });

      expect(
        allLogs.some((log) => {
          return log.includes("Downloading from GitHub");
        }),
      ).toBe(false);
      expect(
        allLogs.some((log) => {
          return log.includes("Uploading compose");
        }),
      ).toBe(false);
    });

    it("should output JSON error for GitHub URL failures", async () => {
      // Configure git checkout to create directory without vm0.yaml
      onGitCheckout = (cwd) => {
        mkdirSync(path.join(cwd, "tutorials/101-intro"), { recursive: true });
      };

      await expect(async () => {
        await composeCommand.parseAsync([
          "node",
          "cli",
          "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
          "--json",
        ]);
      }).rejects.toThrow("process.exit called");

      // Find the JSON error output
      const jsonOutputCall = mockConsoleLog.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0] as string);
          return parsed.error !== undefined;
        } catch {
          return false;
        }
      });

      expect(jsonOutputCall).toBeDefined();
      const result = JSON.parse(jsonOutputCall![0] as string);
      expect(result.error).toContain("vm0.yaml not found");
    });
  });

  describe("missing secrets/variables detection", () => {
    const composeApiHandler = http.post(
      "http://localhost:3000/api/agent/composes",
      () => {
        return HttpResponse.json({
          composeId: "cmp-123",
          name: "test",
          versionId:
            "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a1b2c3d4e5f6",
          action: "created",
        });
      },
    );

    const orgApiHandler = http.get("http://localhost:3000/api/zero/org", () => {
      return HttpResponse.json(orgResponse);
    });

    it("should show missing secrets warning when secrets are missing", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        yaml.stringify({
          version: "1.0",
          agents: {
            test: {
              framework: "claude-code",
              environment: {
                API_KEY: "${{ secrets.API_KEY }}",
                DB_URL: "${{ secrets.DB_URL }}",
              },
            },
          },
        }),
      );

      server.use(
        composeApiHandler,
        orgApiHandler,
        http.get("http://localhost:3000/api/zero/secrets", () => {
          return HttpResponse.json({ secrets: [] });
        }),
        http.get("http://localhost:3000/api/zero/variables", () => {
          return HttpResponse.json({ variables: [] });
        }),
      );

      await composeCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Missing secrets/variables detected");
      expect(logCalls).toContain("API_KEY");
      expect(logCalls).toContain("DB_URL");
    });

    it("should not show missing secrets warning when all secrets exist", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        yaml.stringify({
          version: "1.0",
          agents: {
            test: {
              framework: "claude-code",
              environment: {
                API_KEY: "${{ secrets.API_KEY }}",
              },
            },
          },
        }),
      );

      server.use(
        composeApiHandler,
        orgApiHandler,
        http.get("http://localhost:3000/api/zero/secrets", () => {
          return HttpResponse.json({
            secrets: [
              {
                id: "1",
                name: "API_KEY",
                description: null,
                type: "user",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          });
        }),
      );

      await composeCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).not.toContain("Missing secrets/variables detected");
    });

    it("should show missing secrets and vars when both are missing", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        yaml.stringify({
          version: "1.0",
          agents: {
            test: {
              framework: "claude-code",
              environment: {
                API_KEY: "${{ secrets.API_KEY }}",
                REGION: "${{ vars.REGION }}",
              },
            },
          },
        }),
      );

      server.use(
        composeApiHandler,
        orgApiHandler,
        http.get("http://localhost:3000/api/zero/secrets", () => {
          return HttpResponse.json({ secrets: [] });
        }),
        http.get("http://localhost:3000/api/zero/variables", () => {
          return HttpResponse.json({ variables: [] });
        }),
      );

      await composeCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Missing secrets/variables detected");
      expect(logCalls).toContain("API_KEY");
      expect(logCalls).toContain("REGION");
    });

    it("should not show missing items for required connector-provided bindings", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        yaml.stringify({
          version: "1.0",
          agents: {
            test: {
              framework: "claude-code",
              environment: {
                GH_TOKEN: "${{ secrets.GH_TOKEN }}",
                REGION: "${{ vars.REGION }}",
                GITLAB_HOST: "${{ vars.GITLAB_HOST }}",
              },
            },
          },
        }),
      );

      server.use(
        composeApiHandler,
        orgApiHandler,
        http.get("http://localhost:3000/api/zero/secrets", () => {
          return HttpResponse.json({ secrets: [] });
        }),
        http.get("http://localhost:3000/api/zero/variables", () => {
          return HttpResponse.json({ variables: [] });
        }),
        http.get("http://localhost:3000/api/zero/connectors", () => {
          return HttpResponse.json({
            connectors: [],
            configuredTypes: [],
            connectorProvidedBindings: [
              {
                connectorType: "github",
                authMethod: "oauth",
                namespace: "secrets",
                name: "GH_TOKEN",
                required: true,
                source: {
                  kind: "connector-secret",
                  name: "GITHUB_ACCESS_TOKEN",
                },
              },
              {
                connectorType: "gitlab",
                authMethod: "api-token",
                namespace: "vars",
                name: "REGION",
                required: true,
                source: {
                  kind: "connector-variable",
                  name: "GITLAB_REGION",
                },
              },
              {
                connectorType: "gitlab",
                authMethod: "api-token",
                namespace: "vars",
                name: "GITLAB_HOST",
                required: false,
                source: {
                  kind: "connector-variable",
                  name: "GITLAB_HOST",
                },
              },
            ],
          });
        }),
      );

      await composeCommand.parseAsync(["node", "cli"]);

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("Missing secrets/variables detected");
      expect(logCalls).not.toContain("GH_TOKEN");
      expect(logCalls).not.toContain("REGION");
      expect(logCalls).toContain("GITLAB_HOST");
    });

    it("should not include missing items in JSON output", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        yaml.stringify({
          version: "1.0",
          agents: {
            test: {
              framework: "claude-code",
              environment: {
                API_KEY: "${{ secrets.API_KEY }}",
              },
            },
          },
        }),
      );

      server.use(composeApiHandler);

      await composeCommand.parseAsync(["node", "cli", "--json"]);

      const jsonOutputCall = mockConsoleLog.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0] as string);
          return parsed.composeId !== undefined;
        } catch {
          return false;
        }
      });

      expect(jsonOutputCall).toBeDefined();
      const result = JSON.parse(jsonOutputCall![0] as string);
      // In --json mode, missing items check is skipped for performance
      expect(result.missingSecrets).toBeUndefined();
    });

    it("should not include missing items in JSON output when no items missing", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        yaml.stringify({
          version: "1.0",
          agents: {
            test: {
              framework: "claude-code",
              environment: {
                STATIC: "static-value",
              },
            },
          },
        }),
      );

      server.use(composeApiHandler);

      await composeCommand.parseAsync(["node", "cli", "--json"]);

      const jsonOutputCall = mockConsoleLog.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0] as string);
          return parsed.composeId !== undefined;
        } catch {
          return false;
        }
      });

      expect(jsonOutputCall).toBeDefined();
      const result = JSON.parse(jsonOutputCall![0] as string);
      expect(result.missingSecrets).toBeUndefined();
      expect(result.missingVars).toBeUndefined();
    });

    it("should only show missing items, not already configured ones", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        yaml.stringify({
          version: "1.0",
          agents: {
            test: {
              framework: "claude-code",
              environment: {
                EXISTING_KEY: "${{ secrets.EXISTING_KEY }}",
                MISSING_KEY: "${{ secrets.MISSING_KEY }}",
                EXISTING_VAR: "${{ vars.EXISTING_VAR }}",
                MISSING_VAR: "${{ vars.MISSING_VAR }}",
              },
            },
          },
        }),
      );

      server.use(composeApiHandler);

      await composeCommand.parseAsync(["node", "cli", "--json"]);

      const jsonOutputCall = mockConsoleLog.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0] as string);
          return parsed.composeId !== undefined;
        } catch {
          return false;
        }
      });

      expect(jsonOutputCall).toBeDefined();
      const result = JSON.parse(jsonOutputCall![0] as string);
      // In --json mode, missing items check is skipped for performance
      expect(result.missingSecrets).toBeUndefined();
      expect(result.missingVars).toBeUndefined();
      expect(result).not.toHaveProperty("setupUrl");
    });

    it("should not include connector or secrets info in JSON output", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        yaml.stringify({
          version: "1.0",
          agents: {
            test: {
              framework: "claude-code",
              environment: {
                GH_TOKEN: "${{ secrets.GH_TOKEN }}",
                OTHER_KEY: "${{ secrets.OTHER_KEY }}",
              },
            },
          },
        }),
      );

      server.use(composeApiHandler);

      await composeCommand.parseAsync(["node", "cli", "--json"]);

      const jsonOutputCall = mockConsoleLog.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0] as string);
          return parsed.composeId !== undefined;
        } catch {
          return false;
        }
      });

      expect(jsonOutputCall).toBeDefined();
      const result = JSON.parse(jsonOutputCall![0] as string);
      // In --json mode, missing items check is skipped for performance
      expect(result.missingSecrets).toBeUndefined();
      expect(result).not.toHaveProperty("setupUrl");
    });
  });
});

describe("getSecretsFromComposeContent", () => {
  it("should extract secret names from compose environment", () => {
    const content = {
      version: "1.0",
      agents: {
        myAgent: {
          framework: "claude-code",
          environment: {
            API_KEY: "${{ secrets.API_KEY }}",
            DB_URL: "${{ secrets.DB_URL }}",
            REGION: "${{ vars.REGION }}",
          },
        },
      },
    };
    const secrets = getSecretsFromComposeContent(content);

    expect(secrets.size).toBe(2);
    expect(secrets.has("API_KEY")).toBe(true);
    expect(secrets.has("DB_URL")).toBe(true);
    expect(secrets.has("REGION")).toBe(false);
  });

  it("should return empty set when no secrets in compose", () => {
    const content = {
      version: "1.0",
      agents: {
        myAgent: {
          framework: "claude-code",
          environment: {
            REGION: "${{ vars.REGION }}",
            STATIC: "static-value",
          },
        },
      },
    };
    const secrets = getSecretsFromComposeContent(content);

    expect(secrets.size).toBe(0);
  });

  it("should return empty set for compose without environment", () => {
    const content = {
      version: "1.0",
      agents: {
        myAgent: {
          framework: "claude-code",
        },
      },
    };
    const secrets = getSecretsFromComposeContent(content);

    expect(secrets.size).toBe(0);
  });

  it("should handle nested objects with secrets", () => {
    const content = {
      version: "1.0",
      agents: {
        agent1: {
          environment: {
            KEY1: "${{ secrets.KEY1 }}",
          },
        },
        agent2: {
          environment: {
            KEY2: "${{ secrets.KEY2 }}",
          },
        },
      },
    };
    const secrets = getSecretsFromComposeContent(content);

    expect(secrets.size).toBe(2);
    expect(secrets.has("KEY1")).toBe(true);
    expect(secrets.has("KEY2")).toBe(true);
  });

  it("should deduplicate secrets with same name", () => {
    const content = {
      version: "1.0",
      agents: {
        agent1: {
          environment: {
            API_KEY: "${{ secrets.API_KEY }}",
          },
        },
        agent2: {
          environment: {
            API_KEY: "${{ secrets.API_KEY }}",
          },
        },
      },
    };
    const secrets = getSecretsFromComposeContent(content);

    expect(secrets.size).toBe(1);
    expect(secrets.has("API_KEY")).toBe(true);
  });
});
