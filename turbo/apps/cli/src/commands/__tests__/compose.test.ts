import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server";
import { composeCommand, getSecretsFromComposeContent } from "../compose";
import * as fs from "fs/promises";
import { mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";
import * as yaml from "yaml";
import * as config from "../../lib/api/config";
import * as yamlValidator from "../../lib/domain/yaml-validator";

// Mock dependencies
vi.mock("../../lib/domain/yaml-validator");
vi.mock("../../lib/domain/framework-config", () => ({
  getFrameworkDefaults: vi.fn().mockReturnValue(undefined),
  getDefaultImage: vi.fn().mockReturnValue(undefined),
  getDefaultImageWithApps: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../lib/system-storage", () => ({
  uploadInstructions: vi.fn(),
  uploadSkill: vi.fn(),
}));
vi.mock("../../lib/api/config", () => ({
  getApiUrl: vi.fn(),
  getToken: vi.fn(),
}));

describe("compose command", () => {
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
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-compose-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    vi.mocked(config.getApiUrl).mockResolvedValue("http://localhost:3000");
    vi.mocked(config.getToken).mockResolvedValue("test-token");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
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
        `version: "1.0"\nagents:\n  test:\n    framework: test\n    working_dir: /`,
      );
      vi.mocked(yamlValidator.validateAgentCompose).mockReturnValue({
        valid: true,
      });
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
          return HttpResponse.json({
            id: "scope-123",
            slug: "user-abc12345",
            type: "personal",
            displayName: null,
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          });
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
        `version: "1.0"\nagents:\n  test:\n    working_dir: /`,
      );
      vi.mocked(yamlValidator.validateAgentCompose).mockReturnValue({
        valid: true,
      });
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
          return HttpResponse.json({
            id: "scope-123",
            slug: "user-abc12345",
            type: "personal",
            displayName: null,
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          });
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "config.yaml"]);

      const content = await fs.readFile(
        path.join(tempDir, "config.yaml"),
        "utf8",
      );
      const parsed = yaml.parse(content);
      expect(parsed.version).toBe("1.0");
      expect(yamlValidator.validateAgentCompose).toHaveBeenCalled();
    });
  });

  describe("compose validation", () => {
    beforeEach(async () => {
      await fs.writeFile(
        path.join(tempDir, "config.yaml"),
        `version: "1.0"\nagents:\n  test:\n    framework: test\n    working_dir: /`,
      );
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
      let composeApiCalled = false;
      vi.mocked(yamlValidator.validateAgentCompose).mockReturnValue({
        valid: true,
      });
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
          return HttpResponse.json({
            id: "scope-123",
            slug: "user-abc12345",
            type: "personal",
            displayName: null,
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          });
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
        `version: "1.0"\nagents:\n  test:\n    working_dir: /`,
      );
      vi.mocked(yamlValidator.validateAgentCompose).mockReturnValue({
        valid: true,
      });
      server.use(
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json({
            id: "scope-123",
            slug: "user-abc12345",
            type: "personal",
            displayName: null,
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
          });
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
        `version: "1.0"\nagents:\n  test:\n    framework: test\n    working_dir: /`,
      );
      vi.mocked(yamlValidator.validateAgentCompose).mockReturnValue({
        valid: true,
      });
    });

    it("should handle authentication errors", async () => {
      vi.mocked(config.getToken).mockResolvedValue(undefined);

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
