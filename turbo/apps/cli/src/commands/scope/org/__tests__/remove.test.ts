/**
 * Tests for org remove command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { removeCommand } from "../remove";
import chalk from "chalk";

describe("org remove command", () => {
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

  it("should remove member and show success", async () => {
    server.use(
      http.delete("http://localhost:3000/api/org/members", () => {
        return HttpResponse.json({
          message: "Removed member@example.com from organization",
        });
      }),
    );

    await removeCommand.parseAsync(["node", "cli", "member@example.com"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("member@example.com");
    expect(logCalls).toContain("Removed");
  });

  it("should handle API error", async () => {
    server.use(
      http.delete("http://localhost:3000/api/org/members", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Only admins can remove members",
              code: "FORBIDDEN",
            },
          },
          { status: 403 },
        );
      }),
    );

    await expect(async () => {
      await removeCommand.parseAsync(["node", "cli", "member@example.com"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Only admins can remove"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
