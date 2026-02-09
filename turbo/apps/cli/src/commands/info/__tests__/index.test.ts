/**
 * Tests for info command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): os.homedir() to use temp directory
 * - Real (internal): All CLI code, config readers, real filesystem
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import chalk from "chalk";
import * as os from "os";

// Mock os.homedir to point to temp directory for isolated testing
vi.mock("os", async () => {
  const actual = await vi.importActual<typeof os>("os");
  return {
    ...actual,
    homedir: vi.fn(),
  };
});

describe("info command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockHomedir = vi.mocked(os.homedir);

  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "https://www.vm0.ai");

    // Create temp directory for each test
    tempDir = mkdtempSync(join(tmpdir(), "vm0-info-test-"));
    mockHomedir.mockReturnValue(tempDir);
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();

    // Cleanup temp directory
    rmSync(tempDir, { recursive: true, force: true });
  });

  function getAllOutput(): string[] {
    return mockConsoleLog.mock.calls
      .map((call) => call[0] as string | undefined)
      .filter((call): call is string => call !== undefined);
  }

  // Helper to create config file in temp directory
  function createConfigFile(content: object): void {
    const configDir = join(tempDir, ".vm0");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify(content));
  }

  // Need to dynamically import after mocking os.homedir
  async function runInfoCommand(): Promise<void> {
    // Clear module cache to pick up new homedir mock value
    vi.resetModules();
    const { infoCommand } = await import("../index");
    await infoCommand.parseAsync(["node", "cli"]);
  }

  describe("CLI version display", () => {
    it("should display CLI version at top", async () => {
      await runInfoCommand();

      const allCalls = getAllOutput();
      const firstLine = allCalls[0];
      expect(firstLine).toMatch(/VM0 CLI v\d+\.\d+\.\d+/);
    });
  });

  describe("authentication section", () => {
    it("should show not authenticated when no token exists", async () => {
      // No config file created - not authenticated
      await runInfoCommand();

      const allCalls = getAllOutput();
      expect(allCalls.some((call) => call.includes("Authentication:"))).toBe(
        true,
      );
      expect(allCalls.some((call) => call.includes("Not authenticated"))).toBe(
        true,
      );
    });

    it("should show authenticated via config file when token exists in config", async () => {
      createConfigFile({ token: "test-token-from-config" });

      await runInfoCommand();

      const allCalls = getAllOutput();
      expect(allCalls.some((call) => call.includes("Logged in"))).toBe(true);
      expect(allCalls.some((call) => call.includes("config file"))).toBe(true);
    });

    it("should show authenticated via env var when VM0_TOKEN is set", async () => {
      vi.stubEnv("VM0_TOKEN", "test-token-from-env");

      await runInfoCommand();

      const allCalls = getAllOutput();
      expect(allCalls.some((call) => call.includes("Logged in"))).toBe(true);
      expect(allCalls.some((call) => call.includes("VM0_TOKEN env var"))).toBe(
        true,
      );
    });

    it("should prefer env var over config file for token source display", async () => {
      createConfigFile({ token: "config-token" });
      vi.stubEnv("VM0_TOKEN", "env-token");

      await runInfoCommand();

      const allCalls = getAllOutput();
      // When both exist, env var takes precedence in display
      expect(allCalls.some((call) => call.includes("VM0_TOKEN env var"))).toBe(
        true,
      );
    });

    it("should show config file path", async () => {
      await runInfoCommand();

      const allCalls = getAllOutput();
      expect(allCalls.some((call) => call.includes("Config:"))).toBe(true);
      expect(allCalls.some((call) => call.includes("~/.vm0/config.json"))).toBe(
        true,
      );
    });

    it("should indicate when config file is not found", async () => {
      // No config file created
      await runInfoCommand();

      const allCalls = getAllOutput();
      expect(allCalls.some((call) => call.includes("(not found)"))).toBe(true);
    });

    it("should not show not found when config file exists", async () => {
      createConfigFile({});

      await runInfoCommand();

      const allCalls = getAllOutput();
      const configLine = allCalls.find((call) => call.includes("Config:"));
      expect(configLine).toBeDefined();
      expect(configLine).not.toContain("(not found)");
    });
  });

  describe("API section", () => {
    it("should display API host", async () => {
      await runInfoCommand();

      const allCalls = getAllOutput();
      expect(allCalls.some((call) => call.includes("API:"))).toBe(true);
      expect(allCalls.some((call) => call.includes("Host:"))).toBe(true);
      expect(allCalls.some((call) => call.includes("https://www.vm0.ai"))).toBe(
        true,
      );
    });
  });

  describe("system information display", () => {
    it("should display System section header", async () => {
      await runInfoCommand();

      const allCalls = getAllOutput();
      expect(allCalls.some((call) => call.includes("System:"))).toBe(true);
    });

    it("should display Node version", async () => {
      await runInfoCommand();

      const allCalls = getAllOutput();
      expect(allCalls.some((call) => call.includes("Node:"))).toBe(true);
      expect(allCalls.some((call) => call.includes(process.version))).toBe(
        true,
      );
    });

    it("should display platform and architecture", async () => {
      await runInfoCommand();

      const allCalls = getAllOutput();
      expect(allCalls.some((call) => call.includes("Platform:"))).toBe(true);
      expect(allCalls.some((call) => call.includes(process.platform))).toBe(
        true,
      );
      expect(allCalls.some((call) => call.includes(process.arch))).toBe(true);
    });

    it("should display OS information", async () => {
      await runInfoCommand();

      const allCalls = getAllOutput();
      expect(allCalls.some((call) => call.includes("OS:"))).toBe(true);
      // os.type() returns real value since we only mock homedir
      expect(allCalls.some((call) => call.includes(os.type()))).toBe(true);
    });

    it("should display shell", async () => {
      vi.stubEnv("SHELL", "/bin/zsh");

      await runInfoCommand();

      const allCalls = getAllOutput();
      expect(allCalls.some((call) => call.includes("Shell:"))).toBe(true);
      expect(allCalls.some((call) => call.includes("/bin/zsh"))).toBe(true);
    });

    it("should show unknown when SHELL is not set", async () => {
      vi.stubEnv("SHELL", "");
      delete process.env.SHELL;

      await runInfoCommand();

      const allCalls = getAllOutput();
      expect(
        allCalls.some(
          (call) => call.includes("Shell:") && call.includes("unknown"),
        ),
      ).toBe(true);
    });

    it("should display package manager", async () => {
      await runInfoCommand();

      const allCalls = getAllOutput();
      expect(allCalls.some((call) => call.includes("Package Manager:"))).toBe(
        true,
      );
    });
  });
});
