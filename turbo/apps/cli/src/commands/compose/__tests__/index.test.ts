import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { composeCommand, getSecretsFromComposeContent } from "../index";
import * as fs from "fs/promises";
import { mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";
import * as yaml from "yaml";
import chalk from "chalk";

// Mock uploadSkill since it uses git commands (external network call to GitHub)
vi.mock("../../../lib/storage/system-storage", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../../lib/storage/system-storage")
    >();
  return {
    ...original,
    uploadSkill: vi.fn(),
    uploadInstructions: vi.fn().mockResolvedValue({
      name: "instructions",
      versionId: "a".repeat(64),
      action: "created",
    }),
  };
});

import { uploadSkill } from "../../../lib/storage/system-storage";
const mockUploadSkill = vi.mocked(uploadSkill);

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
      // Remove token to simulate unauthenticated state
      vi.unstubAllEnvs();
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");

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

  describe("skill frontmatter secret detection", () => {
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

        mockUploadSkill.mockResolvedValue({
          name: "agent-skills@elevenlabs",
          versionId: "a".repeat(64),
          action: "created",
          skillName: "elevenlabs",
          frontmatter: {
            vm0_secrets: ["ELEVENLABS_API_KEY"],
          },
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

        mockUploadSkill.mockResolvedValue({
          name: "agent-skills@elevenlabs",
          versionId: "a".repeat(64),
          action: "created",
          skillName: "elevenlabs",
          frontmatter: {
            vm0_secrets: ["ELEVENLABS_API_KEY"],
          },
        });

        server.use(
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

        mockUploadSkill.mockResolvedValue({
          name: "agent-skills@elevenlabs",
          versionId: "a".repeat(64),
          action: "created",
          skillName: "elevenlabs",
          frontmatter: {
            vm0_secrets: ["NEW_SECRET"],
          },
        });

        server.use(
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

        mockUploadSkill.mockResolvedValue({
          name: "agent-skills@elevenlabs",
          versionId: "a".repeat(64),
          action: "created",
          skillName: "elevenlabs",
          frontmatter: {
            vm0_secrets: ["ELEVENLABS_API_KEY"],
          },
        });

        server.use(
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
