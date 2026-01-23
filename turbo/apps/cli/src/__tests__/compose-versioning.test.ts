/**
 * Unit tests for compose versioning behavior
 *
 * These tests validate compose versioning behaviors that were previously
 * tested via E2E tests in t11-vm0-compose-versioning.bats. Moving these
 * to unit tests improves test performance and provides faster feedback.
 *
 * Key behaviors tested:
 * - Version ID display format (8-character hex)
 * - Deterministic hashing (key order independence)
 * - Content deduplication detection ("version exists" message)
 * - Nonexistent version error handling
 *
 * Note: Integration tests in E2E still verify full workflow including
 * compose creation, version specifier resolution, and backward compatibility.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { composeCommand } from "../commands/compose";
import { runCommand } from "../commands/run";
import * as fs from "fs/promises";
import { mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

describe("Compose Versioning", () => {
  let tempDir: string;
  let originalCwd: string;

  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  // Default scope response
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
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-compose-versioning-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
    // Disable chalk colors for deterministic console output assertions
    chalk.level = 0;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("Version ID Display Format", () => {
    it("should display version ID in 8-character hex format", async () => {
      const fullVersionId =
        "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    description: "Test agent for version display"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace`,
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

      // Verify 8-character version is displayed
      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");
      const versionLog = allLogs.find((log) => log.includes("Version:"));
      expect(versionLog).toBeDefined();
      expect(versionLog).toContain("a1b2c3d4");
      // Should not display full 64-character hash
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
    framework: claude-code
    image: "vm0/claude-code:dev"`,
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

      // Verify run command hint contains version
      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");
      const runHint = allLogs.find((log) => log.includes("vm0 run"));
      expect(runHint).toBeDefined();
      expect(runHint).toContain(":deadbeef");
    });
  });

  describe("Content Deduplication Detection", () => {
    it("should display 'version exists' when content is unchanged", async () => {
      const versionId =
        "abc12345def67890abc12345def67890abc12345def67890abc12345def67890";
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    description: "Test agent for deduplication"
    framework: claude-code
    image: "vm0/claude-code:dev"`,
      );

      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          // Server returns "existing" action when content matches existing version
          return HttpResponse.json({
            composeId: "cmp-789",
            name: "test-agent",
            versionId: versionId,
            action: "existing",
          });
        }),
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      // Verify "version exists" message is displayed
      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");
      const existsLog = allLogs.find((log) =>
        log.toLowerCase().includes("version exists"),
      );
      expect(existsLog).toBeDefined();
    });

    it("should display 'Compose created' for new content", async () => {
      const versionId =
        "newver123def67890abc12345def67890abc12345def67890abc12345def67890";
      await fs.writeFile(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    description: "New unique content"
    framework: claude-code
    image: "vm0/claude-code:dev"`,
      );

      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          return HttpResponse.json({
            composeId: "cmp-new",
            name: "test-agent",
            versionId: versionId,
            action: "created",
          });
        }),
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "vm0.yaml"]);

      // Verify "Compose created" message is displayed
      const allLogs = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");
      const createdLog = allLogs.find((log) => log.includes("Compose created"));
      expect(createdLog).toBeDefined();
    });
  });

  describe("Deterministic Hashing (Key Order Independence)", () => {
    /**
     * Note: Actual key-order independence is tested in the server-side
     * content-hash.test.ts. This test validates that the CLI correctly
     * passes content to the server and receives the same version ID.
     *
     * The hashing algorithm uses sorted keys, ensuring:
     * - Same content produces same hash regardless of key order
     * - This is validated at the unit level in web app tests
     */
    it("should receive same version ID for same content with different key order", async () => {
      const expectedVersionId =
        "determin12345678determin12345678determin12345678determin12345678";

      // First compose call - keys in order A
      await fs.writeFile(
        path.join(tempDir, "vm0-a.yaml"),
        `version: "1.0"
agents:
  test-agent:
    description: "Deterministic test"
    framework: claude-code
    image: "vm0/claude-code:dev"
    working_dir: /home/user/workspace`,
      );

      let composeCallCount = 0;
      server.use(
        http.post("http://localhost:3000/api/agent/composes", () => {
          composeCallCount++;
          // Server always returns same version for semantically equal content
          return HttpResponse.json({
            composeId: "cmp-det",
            name: "test-agent",
            versionId: expectedVersionId,
            action: composeCallCount === 1 ? "created" : "existing",
          });
        }),
        http.get("http://localhost:3000/api/scope", () => {
          return HttpResponse.json(scopeResponse);
        }),
      );

      await composeCommand.parseAsync(["node", "cli", "vm0-a.yaml"]);

      const logsAfterFirst = [...mockConsoleLog.mock.calls];
      mockConsoleLog.mockClear();

      // Second compose call - keys in different order (same semantic content)
      await fs.writeFile(
        path.join(tempDir, "vm0-b.yaml"),
        `version: "1.0"
agents:
  test-agent:
    working_dir: /home/user/workspace
    image: "vm0/claude-code:dev"
    framework: claude-code
    description: "Deterministic test"`,
      );

      await composeCommand.parseAsync(["node", "cli", "vm0-b.yaml"]);

      // Both should show same version ID (first 8 chars)
      const logsA = logsAfterFirst
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");
      const logsB = mockConsoleLog.mock.calls
        .map((call) => call[0])
        .filter((log): log is string => typeof log === "string");

      const versionLogA = logsA.find((log) => log.includes("Version:"));
      const versionLogB = logsB.find((log) => log.includes("Version:"));

      expect(versionLogA).toContain("determin");
      expect(versionLogB).toContain("determin");

      // Second call should indicate version exists (deduplication)
      const existsLog = logsB.find((log) =>
        log.toLowerCase().includes("version exists"),
      );
      expect(existsLog).toBeDefined();
    });
  });

  describe("Nonexistent Version Error Handling", () => {
    it("should display 'Version not found' error for invalid version specifier", async () => {
      const testUuid = "550e8400-e29b-41d4-a716-446655440000";
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");
      vi.stubEnv("VM0_TOKEN", "test-token");

      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "my-agent") {
            return HttpResponse.json({
              id: testUuid,
              name: "my-agent",
              headVersionId:
                "abc12345def67890abc12345def67890abc12345def67890abc12345def67890",
              content: {
                version: "1",
                agents: { main: { provider: "claude" } },
              },
              createdAt: "2025-01-01T00:00:00Z",
              updatedAt: "2025-01-01T00:00:00Z",
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.get("http://localhost:3000/api/agent/composes/versions", () => {
          // Return 404 for nonexistent version
          return HttpResponse.json(
            {
              error: {
                message: "Version 'deadbeef' not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "my-agent:deadbeef",
          "test prompt",
          "--artifact-name",
          "test-artifact",
        ]);
      }).rejects.toThrow("process.exit called");

      // Verify "Version not found" error message
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Version not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);

      vi.unstubAllEnvs();
    });

    it("should include version specifier in error message", async () => {
      const testUuid = "550e8400-e29b-41d4-a716-446655440000";
      vi.stubEnv("VM0_API_URL", "http://localhost:3000");
      vi.stubEnv("VM0_TOKEN", "test-token");

      server.use(
        http.get("http://localhost:3000/api/agent/composes", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("name") === "test-agent") {
            return HttpResponse.json({
              id: testUuid,
              name: "test-agent",
              headVersionId: "a".repeat(64),
              content: {
                version: "1",
                agents: { main: { provider: "claude" } },
              },
              createdAt: "2025-01-01T00:00:00Z",
              updatedAt: "2025-01-01T00:00:00Z",
            });
          }
          return HttpResponse.json(
            { error: { message: "Not found", code: "NOT_FOUND" } },
            { status: 404 },
          );
        }),
        http.get("http://localhost:3000/api/agent/composes/versions", () => {
          return HttpResponse.json(
            {
              error: {
                message: "Version 'badc0de1' not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await runCommand.parseAsync([
          "node",
          "cli",
          "test-agent:badc0de1",
          "test prompt",
          "--artifact-name",
          "test-artifact",
        ]);
      }).rejects.toThrow("process.exit called");

      // Error message should contain the specific version that wasn't found
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("badc0de1"),
      );

      vi.unstubAllEnvs();
    });
  });
});
