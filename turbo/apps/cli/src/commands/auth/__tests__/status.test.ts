/**
 * Tests for auth status command
 *
 * Covers:
 * - Authenticated state (with token in config)
 * - Not authenticated state
 * - Token from environment variable
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { statusCommand } from "../status";
import { mkdtempSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

// Mock os.homedir to use temp directory
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "test-auth-status-home-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => TEST_HOME,
  };
});

describe("auth status", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(async () => {
    vi.clearAllMocks();
    chalk.level = 0;

    // Ensure clean config state
    const configDir = path.join(TEST_HOME, ".vm0");
    await fs.rm(configDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();

    // Clean up config
    const configDir = path.join(TEST_HOME, ".vm0");
    await fs.rm(configDir, { recursive: true, force: true });
  });

  describe("authenticated state", () => {
    it("should show authenticated when token exists in config", async () => {
      // Create config with token
      const configDir = path.join(TEST_HOME, ".vm0");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify({ token: "test-token-123" }),
      );

      await statusCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Authenticated"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("logged in"),
      );
    });
  });

  describe("not authenticated state", () => {
    it("should show not authenticated when no token exists", async () => {
      await statusCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
    });
  });

  describe("environment variable token", () => {
    it("should indicate when using VM0_TOKEN env var", async () => {
      vi.stubEnv("VM0_TOKEN", "env-token-456");

      await statusCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("VM0_TOKEN"),
      );
    });
  });
});
