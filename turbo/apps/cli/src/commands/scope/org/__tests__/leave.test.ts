/**
 * Tests for org leave command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW, config file I/O
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { leaveCommand } from "../leave";
import chalk from "chalk";

vi.mock("../../../../lib/api/config", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../../lib/api/config")>();
  return {
    ...original,
    clearOrgToken: vi.fn().mockResolvedValue(undefined),
    loadConfig: vi.fn().mockResolvedValue({ activeScope: undefined }),
  };
});

describe("org leave command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  it("should leave org and show success", async () => {
    server.use(
      http.post("http://localhost:3000/api/org/leave", () => {
        return HttpResponse.json({
          message: "Left organization",
        });
      }),
    );

    await leaveCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("Left scope");
    expect(logCalls).toContain("default scope");
  });

  it("should handle admin-cannot-leave error", async () => {
    server.use(
      http.post("http://localhost:3000/api/org/leave", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Admin cannot leave the organization",
              code: "FORBIDDEN",
            },
          },
          { status: 403 },
        );
      }),
    );

    await expect(async () => {
      await leaveCommand.parseAsync(["node", "cli"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Admin cannot leave"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
