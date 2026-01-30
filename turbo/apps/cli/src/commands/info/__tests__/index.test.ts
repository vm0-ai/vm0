/**
 * Tests for info command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): None (command only reads local config)
 * - Real (internal): All CLI code, config readers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { infoCommand } from "../index";
import chalk from "chalk";

describe("info command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "https://www.vm0.ai");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
  });

  describe("system information display", () => {
    it("should display system information header", async () => {
      await infoCommand.parseAsync(["node", "cli"]);

      const allCalls = mockConsoleLog.mock.calls.map(
        (call) => call[0] as string,
      );

      expect(
        allCalls.some((call) => call.includes("System Information:")),
      ).toBe(true);
    });

    it("should display Node version", async () => {
      await infoCommand.parseAsync(["node", "cli"]);

      const allCalls = mockConsoleLog.mock.calls.map(
        (call) => call[0] as string,
      );

      expect(allCalls.some((call) => call.includes("Node Version:"))).toBe(
        true,
      );
      expect(allCalls.some((call) => call.includes(process.version))).toBe(
        true,
      );
    });

    it("should display platform information", async () => {
      await infoCommand.parseAsync(["node", "cli"]);

      const allCalls = mockConsoleLog.mock.calls.map(
        (call) => call[0] as string,
      );

      expect(allCalls.some((call) => call.includes("Platform:"))).toBe(true);
      expect(allCalls.some((call) => call.includes(process.platform))).toBe(
        true,
      );
    });

    it("should display architecture information", async () => {
      await infoCommand.parseAsync(["node", "cli"]);

      const allCalls = mockConsoleLog.mock.calls.map(
        (call) => call[0] as string,
      );

      expect(allCalls.some((call) => call.includes("Architecture:"))).toBe(
        true,
      );
      expect(allCalls.some((call) => call.includes(process.arch))).toBe(true);
    });

    it("should display API host", async () => {
      await infoCommand.parseAsync(["node", "cli"]);

      const allCalls = mockConsoleLog.mock.calls.map(
        (call) => call[0] as string,
      );

      expect(allCalls.some((call) => call.includes("API Host:"))).toBe(true);
      expect(allCalls.some((call) => call.includes("https://www.vm0.ai"))).toBe(
        true,
      );
    });
  });
});
