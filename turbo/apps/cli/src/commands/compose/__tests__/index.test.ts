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

// Mock downloadGitHubSkill and downloadGitHubDirectory since they use git commands (external system call)
// This is the actual external boundary - git sparse-checkout via child_process.exec
vi.mock("../../../lib/domain/github-skills", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../lib/domain/github-skills")>();
  return {
    ...original,
    downloadGitHubSkill: vi.fn(),
    downloadGitHubDirectory: vi.fn(),
  };
});

// Mock child_process.spawn since it's an external system call boundary
// Used by silentUpgradeAfterCommand to run npm/pnpm install
vi.mock("child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("child_process")>();
  return {
    ...original,
    spawn: vi.fn(),
  };
});

import {
  downloadGitHubSkill,
  downloadGitHubDirectory,
} from "../../../lib/domain/github-skills";
const mockDownloadGitHubSkill = vi.mocked(downloadGitHubSkill);
const mockDownloadGitHubDirectory = vi.mocked(downloadGitHubDirectory);

import { spawn } from "child_process";
const mockSpawn = vi.mocked(spawn);

/**
 * Helper to create a mock skill directory with SKILL.md frontmatter.
 * Returns the path to the skill directory.
 */
function createMockSkillDir(
  destDir: string,
  skillName: string,
  frontmatter: { vm0_secrets?: string[]; vm0_vars?: string[] },
): string {
  const skillDir = path.join(destDir, skillName);
  mkdirSync(skillDir, { recursive: true });

  const frontmatterLines: string[] = [];
  if (frontmatter.vm0_secrets?.length) {
    frontmatterLines.push(
      `vm0_secrets: [${frontmatter.vm0_secrets.map((s) => `"${s}"`).join(", ")}]`,
    );
  }
  if (frontmatter.vm0_vars?.length) {
    frontmatterLines.push(
      `vm0_vars: [${frontmatter.vm0_vars.map((v) => `"${v}"`).join(", ")}]`,
    );
  }

  const skillMd = `---
${frontmatterLines.join("\n")}
---

# ${skillName}

Mock skill for testing.
`;
  writeFileSync(path.join(skillDir, "SKILL.md"), skillMd);
  return skillDir;
}

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

  const scopeResponse = {
    id: "scope-123",
    slug: "user-abc12345",
    type: "personal",
    displayName: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-compose-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
    chalk.level = 0;

    // Default npm registry handler - return same version to skip upgrade
    // This prevents silentUpgradeAfterCommand from attempting real upgrades
    server.use(
      http.get("https://registry.npmjs.org/*/latest", () => {
        return HttpResponse.json({ version: "0.0.0-test" });
      }),
    );

    // Default spawn mock - succeeds immediately
    // This is needed because silentUpgradeAfterCommand uses spawn
    mockSpawn.mockImplementation(() => createMockChildProcess(0) as never);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
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
        `version: "1.0"\nagents:\n  test:\n    framework: claude-code\n    working_dir: /`,
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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
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
        `version: "1.0"\nagents:\n  test:\n    framework: claude-code\n    working_dir: /`,
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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
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
        `version: "1.0"\nagents:\n  default-agent:\n    framework: claude-code\n    working_dir: /`,
      );
      await fs.writeFile(
        path.join(tempDir, "custom.yaml"),
        `version: "1.0"\nagents:\n  custom-agent:\n    framework: claude-code\n    working_dir: /`,
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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
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
        `version: "1.0"\nagents:\n  test:\n    framework: claude-code\n    working_dir: /`,
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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
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
        `version: "1.0"\nagents:\n  ab:\n    working_dir: /`,
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
        `version: "1.0"\nagents:\n  test:\n    framework: claude-code\n    working_dir: /`,
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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "config.yaml"]);

      expect(composeApiCalled).toBe(true);
    });
  });

  describe("API interaction", () => {
    beforeEach(async () => {
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        `version: "1.0"\nagents:\n  test:\n    framework: claude-code\n    working_dir: /`,
      );
      server.use(
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
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
        expect.stringContaining("Compose created: user-abc12345/test-agent"),
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
        expect.stringContaining(
          "Compose version exists: user-abc12345/test-agent",
        ),
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
        expect.stringContaining("vm0 run user-abc12345/test"),
      );
    });
  });

  describe("error handling", () => {
    beforeEach(async () => {
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        `version: "1.0"\nagents:\n  test:\n    framework: claude-code\n    working_dir: /`,
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

  describe("app validation", () => {
    it("should reject invalid app name", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    description: "Test agent with invalid app"
    framework: claude-code
    apps:
      - invalid-app`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid app"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject invalid app tag", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    description: "Test agent with invalid app tag"
    framework: claude-code
    apps:
      - github:invalid-tag`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid app tag"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should accept valid app tags (latest)", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    description: "Test agent with valid app tag"
    framework: claude-code
    apps:
      - github:latest`,
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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose"),
      );
    });

    it("should accept valid app tags (dev)", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    description: "Test agent with dev app tag"
    framework: claude-code
    apps:
      - github:dev`,
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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose"),
      );
    });
  });

  describe("framework validation", () => {
    it("should pass unsupported framework to server (server-side validation)", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    description: "Test agent with unsupported framework"
    framework: unsupported-framework`,
      );

      server.use(
        http.get("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json(
            {
              error: {
                message:
                  'Unsupported framework: "unsupported-framework". Supported frameworks: claude-code, codex',
                code: "BAD_REQUEST",
              },
            },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported framework"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should accept supported framework without image/working_dir", async () => {
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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose"),
      );
    });
  });

  describe("skill URL validation", () => {
    it("should reject invalid GitHub URL in skills", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    framework: claude-code
    image: "vm0/claude-code:dev"
    skills:
      - https://example.com/not-a-github-url`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid skill URL"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject non-tree GitHub URLs", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    framework: claude-code
    image: "vm0/claude-code:dev"
    skills:
      - https://github.com/vm0-ai/vm0-skills/blob/main/github`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid skill URL"),
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
    image: "vm0/claude-code:dev"
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
    image: "vm0/claude-code:dev"
    instructions: nonexistent-file.md`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("runner group validation", () => {
    it("should accept valid runner group format (scope/name)", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  valid-runner-agent:
    description: "Test agent with valid runner group"
    framework: claude-code
    experimental_runner:
      group: acme/production`,
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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
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

      const allErrors = mockConsoleError.mock.calls.map(
        (call) => call[0] as string,
      );
      const hasFormatError = allErrors.some(
        (err) => err.includes("scope/name") || err.includes("format"),
      );
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
          http.get("http://localhost:3000/api/scope", () => {
            return HttpResponse.json(scopeResponse);
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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");
      const versionLog = allLogs.find((log) => log.includes("Version:"));
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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");
      const runHint = allLogs.find((log) => log.includes("vm0 run"));
      expect(runHint).toBeDefined();
      expect(runHint).toContain(":deadbeef");
    });
  });

  describe("deprecation warnings", () => {
    it("should show deprecation warning when image field is explicitly set", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    description: "Test agent with explicit image"
    framework: claude-code
    image: "vm0/claude-code:dev"`,
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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      const allLogs = mockConsoleLog.mock.calls.map(
        (call) => call[0] as string,
      );
      const hasDeprecationWarning = allLogs.some(
        (log) => log.includes("deprecated") && log.includes("image"),
      );
      expect(hasDeprecationWarning).toBe(true);
    });

    it("should still succeed compose even with deprecation warning", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    description: "Test agent with explicit image"
    framework: claude-code
    image: "vm0/claude-code:dev"`,
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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      const allLogs = mockConsoleLog.mock.calls.map(
        (call) => call[0] as string,
      );
      const hasComposeSuccess = allLogs.some((log) =>
        log.includes("Compose created"),
      );
      expect(hasComposeSuccess).toBe(true);
    });
  });

  describe("skill frontmatter secret detection", () => {
    // MSW handlers for storage upload APIs (prepareStorage, commitStorage)
    // Using "existing: true" to skip actual S3 upload
    const storageUploadHandlers = [
      http.post("http://localhost:3000/api/storages/prepare", () => {
        return HttpResponse.json({
          versionId: "a".repeat(64),
          existing: true, // Simulate deduplication to skip S3 upload
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
    ];

    describe("new secret marker", () => {
      it("should mark truly new secrets with (new) when HEAD has no secrets", async () => {
        await fs.writeFile(
          path.join(tempDir, "vm0.yaml"),
          `version: "1.0"
agents:
  my-agent:
    framework: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/elevenlabs`,
        );

        // Mock downloadGitHubSkill to create a skill directory with frontmatter
        mockDownloadGitHubSkill.mockImplementation(async (parsed, destDir) => {
          return createMockSkillDir(destDir, parsed.skillName, {
            vm0_secrets: ["ELEVENLABS_API_KEY"],
          });
        });

        server.use(
          ...storageUploadHandlers,
          http.get("http://localhost:3000/api/agent/composes", () => {
            return HttpResponse.json(
              { error: { message: "Not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          }),
          http.post("http://localhost:3000/api/agent/composes", () => {
            return HttpResponse.json({
              composeId: "cmp-123",
              name: "my-agent",
              versionId: "b".repeat(64),
              action: "created",
            });
          }),
          http.get("http://localhost:3000/api/scope", () => {
            return HttpResponse.json(scopeResponse);
          }),
        );

        await composeCommand.parseAsync(["node", "cli", "vm0.yaml", "--yes"]);

        const allLogs = mockConsoleLog.mock.calls
          .map((call) => call[0])
          .filter((log): log is string => typeof log === "string");

        expect(allLogs.some((log) => log.includes("Secrets:"))).toBe(true);
        expect(
          allLogs.some(
            (log) =>
              log.includes("ELEVENLABS_API_KEY") && log.includes("(new)"),
          ),
        ).toBe(true);
      });

      it("should not mark existing secrets as (new) when HEAD already has them", async () => {
        await fs.writeFile(
          path.join(tempDir, "vm0.yaml"),
          `version: "1.0"
agents:
  my-agent:
    framework: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/elevenlabs`,
        );

        // Mock downloadGitHubSkill to create a skill directory with frontmatter
        mockDownloadGitHubSkill.mockImplementation(async (parsed, destDir) => {
          return createMockSkillDir(destDir, parsed.skillName, {
            vm0_secrets: ["ELEVENLABS_API_KEY"],
          });
        });

        server.use(
          ...storageUploadHandlers,
          http.get("http://localhost:3000/api/agent/composes", () => {
            return HttpResponse.json({
              id: "existing-compose-id",
              name: "my-agent",
              headVersionId: "c".repeat(64),
              content: {
                version: "1.0",
                agents: {
                  "my-agent": {
                    framework: "claude-code",
                    environment: {
                      ELEVENLABS_API_KEY: "${{ secrets.ELEVENLABS_API_KEY }}",
                    },
                  },
                },
              },
              createdAt: "2025-01-01T00:00:00Z",
              updatedAt: "2025-01-01T00:00:00Z",
            });
          }),
          http.post("http://localhost:3000/api/agent/composes", () => {
            return HttpResponse.json({
              composeId: "cmp-123",
              name: "my-agent",
              versionId: "b".repeat(64),
              action: "existing",
            });
          }),
          http.get("http://localhost:3000/api/scope", () => {
            return HttpResponse.json(scopeResponse);
          }),
        );

        await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

        const allLogs = mockConsoleLog.mock.calls
          .map((call) => call[0])
          .filter((log): log is string => typeof log === "string");

        expect(allLogs.some((log) => log.includes("Secrets:"))).toBe(true);
        const secretLine = allLogs.find((log) =>
          log.includes("ELEVENLABS_API_KEY"),
        );
        expect(secretLine).toBeDefined();
        expect(secretLine).not.toContain("(new)");
      });
    });

    describe("confirmation requirement", () => {
      it("should require --yes flag in non-interactive mode when new secrets detected", async () => {
        await fs.writeFile(
          path.join(tempDir, "vm0.yaml"),
          `version: "1.0"
agents:
  my-agent:
    framework: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/elevenlabs`,
        );

        // Mock downloadGitHubSkill to create a skill directory with frontmatter
        mockDownloadGitHubSkill.mockImplementation(async (parsed, destDir) => {
          return createMockSkillDir(destDir, parsed.skillName, {
            vm0_secrets: ["NEW_SECRET"],
          });
        });

        server.use(
          ...storageUploadHandlers,
          http.get("http://localhost:3000/api/agent/composes", () => {
            return HttpResponse.json(
              { error: { message: "Not found", code: "NOT_FOUND" } },
              { status: 404 },
            );
          }),
        );

        vi.stubEnv("CI", "true");

        await expect(async () => {
          await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
        }).rejects.toThrow("process.exit called");

        expect(mockConsoleError).toHaveBeenCalledWith(
          expect.stringContaining("New secrets detected"),
        );
        expect(mockConsoleError).toHaveBeenCalledWith(
          expect.stringContaining("--yes"),
        );
        expect(mockExit).toHaveBeenCalledWith(1);
      });

      it("should not require confirmation when no new secrets (all exist in HEAD)", async () => {
        await fs.writeFile(
          path.join(tempDir, "vm0.yaml"),
          `version: "1.0"
agents:
  my-agent:
    framework: claude-code
    skills:
      - https://github.com/vm0-ai/vm0-skills/tree/main/elevenlabs`,
        );

        // Mock downloadGitHubSkill to create a skill directory with frontmatter
        mockDownloadGitHubSkill.mockImplementation(async (parsed, destDir) => {
          return createMockSkillDir(destDir, parsed.skillName, {
            vm0_secrets: ["ELEVENLABS_API_KEY"],
          });
        });

        server.use(
          ...storageUploadHandlers,
          http.get("http://localhost:3000/api/agent/composes", () => {
            return HttpResponse.json({
              id: "existing-compose-id",
              name: "my-agent",
              headVersionId: "c".repeat(64),
              content: {
                version: "1.0",
                agents: {
                  "my-agent": {
                    framework: "claude-code",
                    environment: {
                      ELEVENLABS_API_KEY: "${{ secrets.ELEVENLABS_API_KEY }}",
                    },
                  },
                },
              },
              createdAt: "2025-01-01T00:00:00Z",
              updatedAt: "2025-01-01T00:00:00Z",
            });
          }),
          http.post("http://localhost:3000/api/agent/composes", () => {
            return HttpResponse.json({
              composeId: "cmp-123",
              name: "my-agent",
              versionId: "b".repeat(64),
              action: "existing",
            });
          }),
          http.get("http://localhost:3000/api/scope", () => {
            return HttpResponse.json(scopeResponse);
          }),
        );

        await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

        const allErrors = mockConsoleError.mock.calls
          .map((call) => call[0])
          .filter((err): err is string => typeof err === "string");
        expect(
          allErrors.some((err) => err.includes("New secrets detected")),
        ).toBe(false);

        const allLogs = mockConsoleLog.mock.calls
          .map((call) => call[0])
          .filter((log): log is string => typeof log === "string");
        expect(allLogs.some((log) => log.includes("Compose"))).toBe(true);
      });
    });
  });

  describe("silent auto-upgrade after successful compose", () => {
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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
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
      mockSpawn.mockImplementation(() => createMockChildProcess(0) as never);

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
      mockSpawn.mockImplementation(() => createMockChildProcess(0) as never);

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
      mockSpawn.mockImplementation(() => createMockChildProcess(0) as never);

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      // No whisper message should appear
      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");
      expect(allLogs.some((log) => log.includes("auto upgrade failed"))).toBe(
        false,
      );
    });

    it("should show whisper when upgrade fails", async () => {
      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.json({ version: "99.0.0" });
        }),
      );

      // Mock spawn to return failure (exit code 1)
      // Use mockImplementation to create fresh EventEmitter each call
      mockSpawn.mockImplementation(() => createMockChildProcess(1) as never);

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      // Whisper message should appear
      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");
      expect(allLogs.some((log) => log.includes("auto upgrade failed"))).toBe(
        true,
      );
      expect(
        allLogs.some((log) => log.includes("npm install -g @vm0/cli@latest")),
      ).toBe(true);
    });

    it("should not attempt upgrade when already on latest version", async () => {
      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          // Return same version as current (simulated by CLI_VERSION)
          return HttpResponse.json({ version: "0.0.0-test" });
        }),
      );

      mockSpawn.mockImplementation(() => createMockChildProcess(0) as never);

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

      mockSpawn.mockImplementation(() => createMockChildProcess(0) as never);

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      // spawn should not be called for bun
      expect(mockSpawn).not.toHaveBeenCalled();

      // No whisper for unsupported PM
      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");
      expect(allLogs.some((log) => log.includes("auto upgrade failed"))).toBe(
        false,
      );
    });

    it("should use pnpm when installed via pnpm", async () => {
      // Set pnpm path
      process.argv = ["/usr/bin/node", "/home/user/.local/share/pnpm/vm0"];

      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.json({ version: "99.0.0" });
        }),
      );

      mockSpawn.mockImplementation(() => createMockChildProcess(0) as never);

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

  describe("--porcelain option", () => {
    it("should output JSON result on success", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framework: claude-code\n    working_dir: /`,
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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "--porcelain"]);

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
        displayName: "user-abc12345/test-agent",
      });
    });

    it("should suppress intermediate output in porcelain mode", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framework: claude-code\n    working_dir: /`,
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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "--porcelain"]);

      // Should not have "Uploading compose..." or "Compose created:" messages
      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");

      expect(allLogs.some((log) => log.includes("Uploading compose"))).toBe(
        false,
      );
      expect(allLogs.some((log) => log.includes("Compose created:"))).toBe(
        false,
      );
      expect(allLogs.some((log) => log.includes("Run your agent"))).toBe(false);
    });

    it("should output JSON error on failure", async () => {
      // No vm0.yaml file exists
      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "--porcelain"]);
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

    it("should imply --yes flag in porcelain mode", async () => {
      // Simple test: verify --porcelain mode sets options.yes = true internally
      // by checking that no confirmation prompts appear in JSON output
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framework: claude-code\n    working_dir: /`,
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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "--porcelain"]);

      // No prompt-related output should appear
      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");

      expect(allLogs.some((log) => log.includes("confirm"))).toBe(false);
      expect(allLogs.some((log) => log.includes("Approve"))).toBe(false);
    });

    it("should skip auto-update in porcelain mode", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"\nagents:\n  test-agent:\n    framework: claude-code\n    working_dir: /`,
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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "--porcelain"]);

      // spawn should NOT be called for auto-update in porcelain mode
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });
});

describe("GitHub URL compose", () => {
  let tempDir: string;
  let originalCwd: string;

  const scopeResponse = {
    id: "scope-123",
    slug: "user-abc12345",
    type: "personal",
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
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-github-compose-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
    chalk.level = 0;

    // Default npm registry handler
    server.use(
      http.get("https://registry.npmjs.org/*/latest", () => {
        return HttpResponse.json({ version: "0.0.0-test" });
      }),
    );

    // Default spawn mock
    mockSpawn.mockImplementation(() => createMockChildProcess(0) as never);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("should show security warning when GitHub URL used without --experimental-shared-compose flag", async () => {
    await expect(async () => {
      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "Composing shared agents requires --experimental-shared-compose flag",
      ),
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        "Composing agents from other users carries security risks.",
      ),
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Only compose agents from users you trust."),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should error when vm0.yaml not found in GitHub directory", async () => {
    // Mock downloadGitHubDirectory to return an empty directory (no vm0.yaml)
    const tempRoot = path.join(tempDir, "github-download");
    const emptyDir = path.join(tempRoot, "tutorials/101-intro");
    mkdirSync(emptyDir, { recursive: true });
    mockDownloadGitHubDirectory.mockResolvedValue({ dir: emptyDir, tempRoot });

    await expect(async () => {
      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
        "--experimental-shared-compose",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("vm0.yaml not found"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should error when compose has volumes", async () => {
    // Mock downloadGitHubDirectory to return a directory with vm0.yaml containing volumes
    const tempRoot = path.join(tempDir, "github-download");
    const cookbookDir = createMockCookbookDir(
      tempRoot,
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
    mockDownloadGitHubDirectory.mockResolvedValue({
      dir: cookbookDir,
      tempRoot,
    });

    await expect(async () => {
      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/104-intro-volume",
        "--experimental-shared-compose",
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
    // Mock downloadGitHubDirectory to return a valid cookbook
    const tempRoot = path.join(tempDir, "github-download");
    const cookbookDir = createMockCookbookDir(
      tempRoot,
      "tutorials/101-intro",
      `version: "1.0"
agents:
  intro:
    framework: claude-code`,
    );
    mockDownloadGitHubDirectory.mockResolvedValue({
      dir: cookbookDir,
      tempRoot,
    });

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
      http.get("http://localhost:3000/api/scope", () => {
        return HttpResponse.json(scopeResponse);
      }),
    );

    await composeCommand.parseAsync([
      "node",
      "cli",
      "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
      "--experimental-shared-compose",
    ]);

    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Downloading from GitHub"),
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Compose created: user-abc12345/intro"),
    );
  });

  it("should handle compose with instructions from GitHub URL", async () => {
    // Create cookbook directory with instructions file
    const tempRoot = path.join(tempDir, "github-download");
    const cookbookDir = createMockCookbookDir(
      tempRoot,
      "tutorials/101-intro",
      `version: "1.0"
agents:
  intro:
    framework: claude-code
    instructions: AGENTS.md`,
    );
    writeFileSync(path.join(cookbookDir, "AGENTS.md"), "# Agent Instructions");
    mockDownloadGitHubDirectory.mockResolvedValue({
      dir: cookbookDir,
      tempRoot,
    });

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
      http.get("http://localhost:3000/api/scope", () => {
        return HttpResponse.json(scopeResponse);
      }),
    );

    await composeCommand.parseAsync([
      "node",
      "cli",
      "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
      "--experimental-shared-compose",
    ]);

    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Uploading instructions"),
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Compose created"),
    );
  });

  it("should cleanup temp directory after successful compose", async () => {
    // Create a temp directory structure that matches what downloadGitHubDirectory returns
    // The function now returns { dir, tempRoot } so cleanup uses tempRoot directly

    // Simulate the actual structure: vm0-github-xxx/tutorials/101-intro
    const vm0TempRoot = mkdtempSync(path.join(tempDir, "vm0-github-"));
    const cookbookDir = createMockCookbookDir(
      vm0TempRoot,
      "tutorials/101-intro",
      `version: "1.0"
agents:
  intro:
    framework: claude-code`,
    );
    mockDownloadGitHubDirectory.mockResolvedValue({
      dir: cookbookDir,
      tempRoot: vm0TempRoot,
    });

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
      http.get("http://localhost:3000/api/scope", () => {
        return HttpResponse.json(scopeResponse);
      }),
    );

    await composeCommand.parseAsync([
      "node",
      "cli",
      "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
      "--experimental-shared-compose",
    ]);

    // The tempRoot should be fully cleaned up (including the .git folder)
    expect(existsSync(vm0TempRoot)).toBe(false);
  });

  it("should detect GitHub tree URLs correctly", async () => {
    // Non-GitHub URL should not trigger experimental flag check
    await expect(async () => {
      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
    }).rejects.toThrow("process.exit called");

    // Should show "not found" error, not the experimental flag error
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Config file not found"),
    );
    expect(mockConsoleError).not.toHaveBeenCalledWith(
      expect.stringContaining("--experimental-shared-compose"),
    );
  });

  describe("repository root URL support", () => {
    it("should recognize plain repository URL as GitHub URL", async () => {
      const tempRoot = path.join(tempDir, "github-download");
      mkdirSync(tempRoot, { recursive: true });
      writeFileSync(
        path.join(tempRoot, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    framework: claude-code`,
      );
      mockDownloadGitHubDirectory.mockResolvedValue({
        dir: tempRoot,
        tempRoot,
      });

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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/owner/repo",
        "--experimental-shared-compose",
      ]);

      expect(mockDownloadGitHubDirectory).toHaveBeenCalledWith(
        "https://github.com/owner/repo",
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Downloading from GitHub"),
      );
    });

    it("should recognize tree URL without path (root) as GitHub URL", async () => {
      const tempRoot = path.join(tempDir, "github-download");
      mkdirSync(tempRoot, { recursive: true });
      writeFileSync(
        path.join(tempRoot, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    framework: claude-code`,
      );
      mockDownloadGitHubDirectory.mockResolvedValue({
        dir: tempRoot,
        tempRoot,
      });

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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/owner/repo/tree/main",
        "--experimental-shared-compose",
      ]);

      expect(mockDownloadGitHubDirectory).toHaveBeenCalledWith(
        "https://github.com/owner/repo/tree/main",
      );
    });

    it("should require --experimental-shared-compose for plain repo URL", async () => {
      await expect(async () => {
        await composeCommand.parseAsync([
          "node",
          "cli",
          "https://github.com/owner/repo",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("--experimental-shared-compose"),
      );
    });

    it("should handle tree URL with trailing slash (root)", async () => {
      const tempRoot = path.join(tempDir, "github-download");
      mkdirSync(tempRoot, { recursive: true });
      writeFileSync(
        path.join(tempRoot, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    framework: claude-code`,
      );
      mockDownloadGitHubDirectory.mockResolvedValue({
        dir: tempRoot,
        tempRoot,
      });

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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/owner/repo/tree/main/",
        "--experimental-shared-compose",
      ]);

      expect(mockDownloadGitHubDirectory).toHaveBeenCalledWith(
        "https://github.com/owner/repo/tree/main/",
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose created"),
      );
    });

    it("should handle tree URL with trailing slash (path)", async () => {
      const tempRoot = path.join(tempDir, "github-download");
      const subDir = path.join(tempRoot, "examples/101-intro");
      mkdirSync(subDir, { recursive: true });
      writeFileSync(
        path.join(subDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    framework: claude-code`,
      );
      mockDownloadGitHubDirectory.mockResolvedValue({
        dir: subDir,
        tempRoot,
      });

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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/owner/repo/tree/main/examples/101-intro/",
        "--experimental-shared-compose",
      ]);

      expect(mockDownloadGitHubDirectory).toHaveBeenCalledWith(
        "https://github.com/owner/repo/tree/main/examples/101-intro/",
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose created"),
      );
    });
  });

  describe("existing agent overwrite confirmation", () => {
    it("should prompt for confirmation when agent already exists (non-interactive without --yes)", async () => {
      const tempRoot = path.join(tempDir, "github-download");
      const cookbookDir = createMockCookbookDir(
        tempRoot,
        "tutorials/101-intro",
        `version: "1.0"
agents:
  intro:
    framework: claude-code`,
      );
      mockDownloadGitHubDirectory.mockResolvedValue({
        dir: cookbookDir,
        tempRoot,
      });

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
          "--experimental-shared-compose",
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
      const tempRoot = path.join(tempDir, "github-download");
      const cookbookDir = createMockCookbookDir(
        tempRoot,
        "tutorials/101-intro",
        `version: "1.0"
agents:
  intro:
    framework: claude-code`,
      );
      mockDownloadGitHubDirectory.mockResolvedValue({
        dir: cookbookDir,
        tempRoot,
      });

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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      // Non-interactive mode
      vi.stubEnv("CI", "true");

      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
        "--experimental-shared-compose",
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
      const tempRoot = path.join(tempDir, "github-download");
      const cookbookDir = createMockCookbookDir(
        tempRoot,
        "tutorials/101-intro",
        `version: "1.0"
agents:
  new-agent:
    framework: claude-code`,
      );
      mockDownloadGitHubDirectory.mockResolvedValue({
        dir: cookbookDir,
        tempRoot,
      });

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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
        "--experimental-shared-compose",
      ]);

      // Should not show the "already exists" warning
      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");
      expect(allLogs.some((log) => log.includes("already exists"))).toBe(false);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose created"),
      );
    });
  });

  describe("--porcelain option with GitHub URL", () => {
    it("should output JSON result for GitHub URL compose", async () => {
      const tempRoot = path.join(tempDir, "github-download");
      const cookbookDir = createMockCookbookDir(
        tempRoot,
        "tutorials/101-intro",
        `version: "1.0"
agents:
  intro:
    framework: claude-code`,
      );
      mockDownloadGitHubDirectory.mockResolvedValue({
        dir: cookbookDir,
        tempRoot,
      });

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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
        "--experimental-shared-compose",
        "--porcelain",
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
        displayName: "user-abc12345/intro",
      });
    });

    it("should suppress intermediate output for GitHub URL in porcelain mode", async () => {
      const tempRoot = path.join(tempDir, "github-download");
      const cookbookDir = createMockCookbookDir(
        tempRoot,
        "tutorials/101-intro",
        `version: "1.0"
agents:
  intro:
    framework: claude-code`,
      );
      mockDownloadGitHubDirectory.mockResolvedValue({
        dir: cookbookDir,
        tempRoot,
      });

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
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
        "--experimental-shared-compose",
        "--porcelain",
      ]);

      // Should not have "Downloading from GitHub..." message
      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");

      expect(
        allLogs.some((log) => log.includes("Downloading from GitHub")),
      ).toBe(false);
      expect(allLogs.some((log) => log.includes("Uploading compose"))).toBe(
        false,
      );
    });

    it("should output JSON error for GitHub URL failures", async () => {
      // Mock downloadGitHubDirectory to return an empty directory (no vm0.yaml)
      const tempRoot = path.join(tempDir, "github-download");
      const emptyDir = path.join(tempRoot, "tutorials/101-intro");
      mkdirSync(emptyDir, { recursive: true });
      mockDownloadGitHubDirectory.mockResolvedValue({
        dir: emptyDir,
        tempRoot,
      });

      await expect(async () => {
        await composeCommand.parseAsync([
          "node",
          "cli",
          "https://github.com/vm0-ai/vm0-cookbooks/tree/main/tutorials/101-intro",
          "--experimental-shared-compose",
          "--porcelain",
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
