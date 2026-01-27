/**
 * Unit tests for compose validation logic
 *
 * These tests validate compose configuration validation that was previously
 * tested via E2E tests in t17-vm0-simplified-compose.bats. Moving these to
 * unit tests improves test performance and provides faster feedback during
 * development.
 *
 * Key behaviors tested:
 * - Invalid app validation (unsupported apps)
 * - Invalid app tag validation
 * - Unsupported framework handling (requires explicit image)
 * - Invalid skill URL validation
 * - Empty instructions validation
 * - Nonexistent instructions file handling
 * - Deprecation warning output for explicit image field
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { composeCommand } from "../commands/compose";
import * as fs from "fs/promises";
import { mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";

describe("Compose Validation", () => {
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
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-compose-validation-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("Invalid App Validation", () => {
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

    it("should provide helpful error message with supported apps list", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    description: "Test agent with invalid app"
    framework: claude-code
    apps:
      - unsupported-tool`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
      }).rejects.toThrow("process.exit called");

      // Error message should include the list of supported apps
      const allErrors = mockConsoleError.mock.calls.map(
        (call) => call[0] as string,
      );
      const hasAppError = allErrors.some(
        (err) =>
          err.includes("Invalid app") ||
          err.includes("unsupported-tool") ||
          err.includes("github"),
      );
      expect(hasAppError).toBe(true);
    });
  });

  describe("Invalid App Tag Validation", () => {
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
            versionId: "a1b2c3d4e5f6g7h8",
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

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
      // Should not throw - compose succeeds
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
            versionId: "a1b2c3d4e5f6g7h8",
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

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
      // Should not throw - compose succeeds
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose"),
      );
    });
  });

  describe("Unsupported Framework Handling", () => {
    it("should pass unsupported framework to server (server-side validation)", async () => {
      // Unsupported frameworks are now validated server-side
      // CLI passes through, server returns 400
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

    it("should accept supported framework without image/working_dir (server resolves)", async () => {
      // Supported frameworks get image/working_dir resolved server-side
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
            versionId: "a1b2c3d4e5f6g7h8",
            action: "created",
            updatedAt: "2025-01-01T00:00:00Z",
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

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
      // Should not throw - compose succeeds
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Compose"),
      );
    });
  });

  describe("Invalid Skill URL Validation", () => {
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

    it("should provide expected URL format in error message", async () => {
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    framework: claude-code
    image: "vm0/claude-code:dev"
    skills:
      - https://invalid-url.com/skill`,
      );

      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
      }).rejects.toThrow("process.exit called");

      // Error message should include the expected format
      const allErrors = mockConsoleError.mock.calls.map(
        (call) => call[0] as string,
      );
      const hasFormatHint = allErrors.some(
        (err) =>
          err.includes("github.com") ||
          err.includes("/tree/") ||
          err.includes("Expected format"),
      );
      expect(hasFormatHint).toBe(true);
    });
  });

  describe("Empty Instructions Validation", () => {
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
  });

  describe("Nonexistent Instructions File", () => {
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

      // The upload will fail because the file doesn't exist
      await expect(async () => {
        await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("Deprecation Warning for Explicit Image", () => {
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
            versionId: "a1b2c3d4e5f6g7h8",
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

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      // Should show deprecation warning
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
            versionId: "a1b2c3d4e5f6g7h8",
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

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      // Compose should still succeed
      const allLogs = mockConsoleLog.mock.calls.map(
        (call) => call[0] as string,
      );
      const hasComposeSuccess = allLogs.some((log) =>
        log.includes("Compose created"),
      );
      expect(hasComposeSuccess).toBe(true);
    });
  });
});
