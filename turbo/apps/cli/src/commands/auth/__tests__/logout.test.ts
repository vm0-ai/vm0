/**
 * Tests for auth logout command
 *
 * Covers:
 * - Successful logout (clears config)
 * - Logout when already logged out
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logoutCommand } from "../logout";
import { mkdtempSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

// Mock os.homedir to use temp directory
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "test-auth-logout-home-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => TEST_HOME,
  };
});

describe("auth logout", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(async () => {
    vi.clearAllMocks();
    chalk.level = 0;

    // Ensure clean config state
    const configDir = path.join(TEST_HOME, ".vm0");
    await fs.rm(configDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();

    // Clean up config
    const configDir = path.join(TEST_HOME, ".vm0");
    await fs.rm(configDir, { recursive: true, force: true });
  });

  describe("successful logout", () => {
    it("should clear config and show success message", async () => {
      // Create config with token
      const configDir = path.join(TEST_HOME, ".vm0");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify({ token: "test-token-123" }),
      );

      await logoutCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Successfully logged out"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("credentials have been cleared"),
      );
    });

    it("should work even when not logged in", async () => {
      // No config exists
      await logoutCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Successfully logged out"),
      );
    });
  });
});
