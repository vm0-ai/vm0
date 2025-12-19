import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupToken } from "../auth";
import * as config from "../config";
import { existsSync } from "fs";
import { unlink, mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const CONFIG_DIR = join(homedir(), ".vm0");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

describe("auth", () => {
  const originalEnv = { ...process.env };
  const originalExit = process.exit;
  const mockExit = vi.fn() as unknown as typeof process.exit;

  beforeEach(async () => {
    // Clean up any existing test config
    if (existsSync(CONFIG_FILE)) {
      await unlink(CONFIG_FILE);
    }
    // Reset environment variables
    delete process.env.VM0_TOKEN;
    // Mock process.exit
    process.exit = mockExit;
  });

  afterEach(async () => {
    // Restore original env vars
    process.env = { ...originalEnv };
    // Restore process.exit
    process.exit = originalExit;
    vi.restoreAllMocks();
    // Clean up test config
    if (existsSync(CONFIG_FILE)) {
      await unlink(CONFIG_FILE);
    }
  });

  describe("setupToken", () => {
    it("should output token with human-readable format when authenticated via config file", async () => {
      await mkdir(CONFIG_DIR, { recursive: true });
      await config.saveConfig({ token: "vm0_live_test123" });
      const consoleSpy = vi.spyOn(console, "log");

      await setupToken();

      const logCalls = consoleSpy.mock.calls.flat().join(" ");
      expect(logCalls).toContain("Authentication token exported successfully");
      expect(logCalls).toContain("Your token:");
      expect(logCalls).toContain("vm0_live_test123");
      expect(logCalls).toContain("export VM0_TOKEN=<token>");
    });

    it("should output token with human-readable format when authenticated via VM0_TOKEN env var", async () => {
      process.env.VM0_TOKEN = "vm0_live_envtoken456";
      const consoleSpy = vi.spyOn(console, "log");

      await setupToken();

      const logCalls = consoleSpy.mock.calls.flat().join(" ");
      expect(logCalls).toContain("Authentication token exported successfully");
      expect(logCalls).toContain("vm0_live_envtoken456");
      expect(logCalls).toContain("export VM0_TOKEN=<token>");
    });

    it("should exit with error and show instructions when not authenticated", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error");

      await setupToken();

      expect(consoleErrorSpy).toHaveBeenCalled();
      // Check that helpful instructions are shown
      const errorCalls = consoleErrorSpy.mock.calls.flat().join(" ");
      expect(errorCalls).toContain("Not authenticated");
      expect(errorCalls).toContain("vm0 auth login");
      expect(errorCalls).toContain("CI/CD");
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
