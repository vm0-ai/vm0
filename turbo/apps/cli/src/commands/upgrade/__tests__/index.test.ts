/**
 * Tests for upgrade command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): npm registry via MSW, child_process.spawn
 * - Real (internal): All CLI code including update-checker logic
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { createMockChildProcess } from "../../../mocks/spawn-helpers";

// Mock child_process for package manager commands (external tools)
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "child_process";
import { upgradeCommand } from "..";

describe("upgrade command", () => {
  const originalArgv = process.argv;

  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: npm package manager
    process.argv = ["/usr/bin/node", "/usr/local/bin/vm0"];
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("should upgrade via npm when new version is available", async () => {
    server.use(
      http.get("https://registry.npmjs.org/*/latest", () => {
        return HttpResponse.json({ version: "99.0.0" });
      }),
    );
    vi.mocked(spawn).mockImplementation(
      () => createMockChildProcess(0) as never,
    );

    await upgradeCommand.parseAsync(["node", "cli"]);

    expect(spawn).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "@vm0/cli@latest"],
      expect.objectContaining({ stdio: "inherit" }),
    );

    const allLogs = mockConsoleLog.mock.calls
      .map((call) => call[0])
      .filter((log): log is string => typeof log === "string");

    expect(
      allLogs.some((log) => log.includes("Upgraded from 0.0.0-test to 99.0.0")),
    ).toBe(true);
  });

  it("should upgrade via pnpm when installed with pnpm", async () => {
    process.argv = [
      "/usr/bin/node",
      "/home/user/.local/share/pnpm/global/5/node_modules/.bin/vm0",
    ];

    server.use(
      http.get("https://registry.npmjs.org/*/latest", () => {
        return HttpResponse.json({ version: "99.0.0" });
      }),
    );
    vi.mocked(spawn).mockImplementation(
      () => createMockChildProcess(0) as never,
    );

    await upgradeCommand.parseAsync(["node", "cli"]);

    expect(spawn).toHaveBeenCalledWith(
      "pnpm",
      ["add", "-g", "@vm0/cli@latest"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("should report already up to date when on latest version", async () => {
    server.use(
      http.get("https://registry.npmjs.org/*/latest", () => {
        return HttpResponse.json({ version: "0.0.0-test" });
      }),
    );

    await upgradeCommand.parseAsync(["node", "cli"]);

    expect(spawn).not.toHaveBeenCalled();

    const allLogs = mockConsoleLog.mock.calls
      .map((call) => call[0])
      .filter((log): log is string => typeof log === "string");

    expect(allLogs.some((log) => log.includes("Already up to date"))).toBe(
      true,
    );
  });

  it("should exit with error when version check fails", async () => {
    server.use(
      http.get("https://registry.npmjs.org/*/latest", () => {
        return new HttpResponse(null, { status: 500 });
      }),
    );

    await expect(async () => {
      await upgradeCommand.parseAsync(["node", "cli"]);
    }).rejects.toThrow("process.exit called");

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(spawn).not.toHaveBeenCalled();

    const allErrors = mockConsoleError.mock.calls
      .map((call) => call[0])
      .filter((log): log is string => typeof log === "string");

    expect(
      allErrors.some((log) => log.includes("Could not check for updates")),
    ).toBe(true);
  });

  it("should show manual instructions for bun", async () => {
    process.argv = ["/usr/bin/node", "/home/user/.bun/bin/vm0"];

    server.use(
      http.get("https://registry.npmjs.org/*/latest", () => {
        return HttpResponse.json({ version: "99.0.0" });
      }),
    );

    await upgradeCommand.parseAsync(["node", "cli"]);

    expect(spawn).not.toHaveBeenCalled();

    const allLogs = mockConsoleLog.mock.calls
      .map((call) => call[0])
      .filter((log): log is string => typeof log === "string");

    expect(allLogs.some((log) => log.includes("not supported for bun"))).toBe(
      true,
    );
    expect(
      allLogs.some((log) => log.includes("bun add -g @vm0/cli@latest")),
    ).toBe(true);
  });

  it("should show manual instructions for yarn", async () => {
    process.argv = ["/usr/bin/node", "/home/user/.yarn/bin/vm0"];

    server.use(
      http.get("https://registry.npmjs.org/*/latest", () => {
        return HttpResponse.json({ version: "99.0.0" });
      }),
    );

    await upgradeCommand.parseAsync(["node", "cli"]);

    expect(spawn).not.toHaveBeenCalled();

    const allLogs = mockConsoleLog.mock.calls
      .map((call) => call[0])
      .filter((log): log is string => typeof log === "string");

    expect(allLogs.some((log) => log.includes("not supported for yarn"))).toBe(
      true,
    );
    expect(
      allLogs.some((log) => log.includes("yarn global add @vm0/cli@latest")),
    ).toBe(true);
  });

  it("should show manual instructions for unknown package manager", async () => {
    process.argv = ["/usr/bin/node", "/some/random/path/vm0"];

    server.use(
      http.get("https://registry.npmjs.org/*/latest", () => {
        return HttpResponse.json({ version: "99.0.0" });
      }),
    );

    await upgradeCommand.parseAsync(["node", "cli"]);

    expect(spawn).not.toHaveBeenCalled();

    const allLogs = mockConsoleLog.mock.calls
      .map((call) => call[0])
      .filter((log): log is string => typeof log === "string");

    expect(
      allLogs.some((log) =>
        log.includes("Could not detect your package manager"),
      ),
    ).toBe(true);
    expect(
      allLogs.some((log) => log.includes("npm install -g @vm0/cli@latest")),
    ).toBe(true);
  });

  it("should show error when upgrade fails", async () => {
    server.use(
      http.get("https://registry.npmjs.org/*/latest", () => {
        return HttpResponse.json({ version: "99.0.0" });
      }),
    );
    vi.mocked(spawn).mockImplementation(
      () => createMockChildProcess(1) as never,
    );

    await expect(async () => {
      await upgradeCommand.parseAsync(["node", "cli"]);
    }).rejects.toThrow("process.exit called");

    expect(mockExit).toHaveBeenCalledWith(1);

    const allErrors = mockConsoleError.mock.calls
      .map((call) => call[0])
      .filter((log): log is string => typeof log === "string");

    expect(allErrors.some((log) => log.includes("Upgrade failed"))).toBe(true);
    expect(
      allErrors.some((log) => log.includes("npm install -g @vm0/cli@latest")),
    ).toBe(true);
  });
});
