import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { setupToken } from "../auth";
import * as config from "../config";

const TEST_HOME = join(tmpdir(), `vm0-auth-test-${process.pid}`);
const CONFIG_DIR = join(TEST_HOME, ".vm0");

vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => TEST_HOME,
  };
});

describe("auth", () => {
  const originalExit = process.exit;
  const mockExit = vi.fn() as unknown as typeof process.exit;

  beforeEach(async () => {
    // Ensure clean state
    await rm(CONFIG_DIR, { recursive: true, force: true });
    // Mock process.exit
    process.exit = mockExit;
    // Silence console output
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    // Restore process.exit
    process.exit = originalExit;
    vi.restoreAllMocks();
    await rm(CONFIG_DIR, { recursive: true, force: true });
  });

  describe("setupToken", () => {
    it("should output token with human-readable format when authenticated via config file", async () => {
      await mkdir(CONFIG_DIR, { recursive: true });
      await config.saveConfig({ token: "vm0_live_test123" });

      await setupToken();

      const logCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
      expect(logCalls).toContain("Authentication token exported successfully");
      expect(logCalls).toContain("Your token:");
      expect(logCalls).toContain("vm0_live_test123");
      expect(logCalls).toContain("export VM0_TOKEN=<token>");
    });

    it("should output token with human-readable format when authenticated via VM0_TOKEN env var", async () => {
      vi.stubEnv("VM0_TOKEN", "vm0_live_envtoken456");

      await setupToken();

      const logCalls = vi.mocked(console.log).mock.calls.flat().join(" ");
      expect(logCalls).toContain("Authentication token exported successfully");
      expect(logCalls).toContain("vm0_live_envtoken456");
      expect(logCalls).toContain("export VM0_TOKEN=<token>");
    });

    it("should exit with error and show instructions when not authenticated", async () => {
      await setupToken();

      expect(console.error).toHaveBeenCalled();
      // Check that helpful instructions are shown
      const errorCalls = vi.mocked(console.error).mock.calls.flat().join(" ");
      expect(errorCalls).toContain("Not authenticated");
      expect(errorCalls).toContain("vm0 auth login");
      expect(errorCalls).toContain("CI/CD");
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
