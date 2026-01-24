/**
 * Unit tests for experimental_runner group validation
 *
 * These tests validate runner group format validation that was previously
 * tested via E2E tests in t02-experimental-runner-e2e.bats. Moving these to
 * unit tests improves test performance and provides faster feedback during
 * development.
 *
 * Key behaviors tested:
 * - Valid runner group format (scope/name)
 * - Invalid runner group format (missing slash)
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { composeCommand } from "../commands/compose";
import * as fs from "fs/promises";
import { mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";

describe("Runner Group Validation", () => {
  let tempDir: string;
  let originalCwd: string;
  let mockExit: MockInstance<typeof process.exit>;
  let mockConsoleLog: MockInstance<typeof console.log>;
  let mockConsoleError: MockInstance<typeof console.error>;

  beforeEach(() => {
    mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-runner-validation-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("experimental_runner group format", () => {
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

      // Error message should mention the scope/name format requirement
      const allErrors = mockConsoleError.mock.calls.map(
        (call) => call[0] as string,
      );
      const hasFormatError = allErrors.some(
        (err) => err.includes("scope/name") || err.includes("format"),
      );
      expect(hasFormatError).toBe(true);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    // Test multiple valid formats using it.each for proper test isolation
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
        expect(mockConsoleLog).toHaveBeenCalledWith(
          expect.stringContaining("Compose"),
        );
      },
    );

    // Test multiple invalid formats using it.each for proper test isolation
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
});
