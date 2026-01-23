/**
 * Unit tests for volume command validation and error handling
 *
 * These tests validate volume command behaviors that don't require full E2E testing.
 * They replace E2E tests that tested validation logic through the full stack.
 *
 * Key behaviors tested:
 * - Volume name validation on init command
 * - Pull command error handling for non-existent versions
 *
 * Note: Volume status validation tests are already covered in volume-status.test.ts
 * Note: Storage name validation is already covered in storage-utils.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { initCommand } from "../commands/volume/init";
import { pullCommand } from "../commands/volume/pull";
import * as storageUtils from "../lib/storage/storage-utils";
import chalk from "chalk";

// Mock storage-utils for filesystem operations
// Note: Consider replacing with real implementations using temp directories
vi.mock("../lib/storage/storage-utils");

describe("Volume Command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  describe("volume init - name validation", () => {
    beforeEach(() => {
      // Mock readStorageConfig to return null (no existing config)
      vi.mocked(storageUtils.readStorageConfig).mockResolvedValue(null);
      // Mock isValidStorageName with actual implementation
      vi.mocked(storageUtils.isValidStorageName).mockImplementation(
        (name: string) => {
          if (name.length < 3 || name.length > 64) {
            return false;
          }
          const pattern = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
          return pattern.test(name) && !name.includes("--");
        },
      );
    });

    it("should reject uppercase volume names with --name flag", async () => {
      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "INVALID_NAME"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid volume name"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("INVALID_NAME"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject names with underscores", async () => {
      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "my_dataset"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid volume name"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject names that are too short", async () => {
      await expect(async () => {
        await initCommand.parseAsync(["node", "cli", "--name", "ab"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid volume name"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should show example valid names on validation error", async () => {
      await expect(async () => {
        await initCommand.parseAsync([
          "node",
          "cli",
          "--name",
          "INVALID-NAME!",
        ]);
      }).rejects.toThrow("process.exit called");

      // Should show helpful examples
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("my-dataset"),
      );
    });

    it("should accept valid lowercase names with hyphens", async () => {
      vi.mocked(storageUtils.writeStorageConfig).mockResolvedValue(undefined);

      await initCommand.parseAsync(["node", "cli", "--name", "my-dataset"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Initialized volume"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("my-dataset"),
      );
    });
  });

  describe("volume pull - error handling", () => {
    beforeEach(() => {
      vi.mocked(storageUtils.readStorageConfig).mockResolvedValue({
        name: "test-volume",
        type: "volume",
      });
    });

    it("should fail with error when pulling non-existent version", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          // Return 404 for non-existent version
          return HttpResponse.json(
            {
              error: {
                message: `Version "00000000" not found for storage "test-volume"`,
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await pullCommand.parseAsync(["node", "cli", "00000000"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Pull failed"),
      );
      // The error message contains "not found" from the API response
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should show helpful message when version not found", async () => {
      server.use(
        http.get("http://localhost:3000/api/storages/download", () => {
          return HttpResponse.json(
            {
              error: {
                message: `Version "nonexistent" not found`,
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await pullCommand.parseAsync(["node", "cli", "nonexistent"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Pull failed"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error if no config exists for pull", async () => {
      vi.mocked(storageUtils.readStorageConfig).mockResolvedValue(null);

      await expect(async () => {
        await pullCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No volume initialized"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 volume init"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
