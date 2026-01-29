/**
 * Unit tests for the info command
 *
 * These tests validate that the info command displays system information correctly.
 * This replaces the E2E test from ser-t01-smoke.bats which tested the same behavior
 * through the full stack.
 *
 * Key behaviors tested:
 * - Displays "System Information:" header
 * - Shows Node version, platform, and architecture
 * - Shows API host from configuration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import { program } from "../index";

describe("Info Command", () => {
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

  it("should display system information header", async () => {
    await program.parseAsync(["node", "cli", "info"]);

    const allCalls = mockConsoleLog.mock.calls.map((call) => call[0] as string);

    expect(allCalls.some((call) => call.includes("System Information:"))).toBe(
      true,
    );
  });

  it("should display Node version", async () => {
    const { program } = await import("../index");

    await program.parseAsync(["node", "cli", "info"]);

    const allCalls = mockConsoleLog.mock.calls.map((call) => call[0] as string);

    expect(allCalls.some((call) => call.includes("Node Version:"))).toBe(true);
    expect(allCalls.some((call) => call.includes(process.version))).toBe(true);
  });

  it("should display platform information", async () => {
    const { program } = await import("../index");

    await program.parseAsync(["node", "cli", "info"]);

    const allCalls = mockConsoleLog.mock.calls.map((call) => call[0] as string);

    expect(allCalls.some((call) => call.includes("Platform:"))).toBe(true);
    expect(allCalls.some((call) => call.includes(process.platform))).toBe(true);
  });

  it("should display architecture information", async () => {
    const { program } = await import("../index");

    await program.parseAsync(["node", "cli", "info"]);

    const allCalls = mockConsoleLog.mock.calls.map((call) => call[0] as string);

    expect(allCalls.some((call) => call.includes("Architecture:"))).toBe(true);
    expect(allCalls.some((call) => call.includes(process.arch))).toBe(true);
  });

  it("should display API host", async () => {
    const { program } = await import("../index");

    await program.parseAsync(["node", "cli", "info"]);

    const allCalls = mockConsoleLog.mock.calls.map((call) => call[0] as string);

    expect(allCalls.some((call) => call.includes("API Host:"))).toBe(true);
  });
});
