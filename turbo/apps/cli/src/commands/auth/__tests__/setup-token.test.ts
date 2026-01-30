/**
 * Tests for auth setup-token command
 *
 * Covers:
 * - Token output when authenticated (via config)
 * - Token output when authenticated (via env var)
 * - Error when not authenticated
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupTokenCommand } from "../setup-token";
import { mkdtempSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

// Mock os.homedir to use temp directory
const TEST_HOME = mkdtempSync(
  path.join(os.tmpdir(), "test-auth-setup-token-home-"),
);
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => TEST_HOME,
  };
});

describe("auth setup-token", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
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
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();

    // Clean up config
    const configDir = path.join(TEST_HOME, ".vm0");
    await fs.rm(configDir, { recursive: true, force: true });
  });

  describe("authenticated via config", () => {
    it("should output token from config file", async () => {
      // Create config with token
      const configDir = path.join(TEST_HOME, ".vm0");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify({ token: "vm0_live_test123" }),
      );

      await setupTokenCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("token exported successfully"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith("vm0_live_test123");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("export VM0_TOKEN"),
      );
    });
  });

  describe("authenticated via environment", () => {
    it("should output token from VM0_TOKEN env var", async () => {
      vi.stubEnv("VM0_TOKEN", "vm0_live_envtoken456");

      await setupTokenCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("token exported successfully"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith("vm0_live_envtoken456");
    });
  });

  describe("not authenticated", () => {
    it("should exit with error and show instructions", async () => {
      await expect(async () => {
        await setupTokenCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 auth login"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("CI/CD"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
