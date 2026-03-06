/**
 * Tests for org invite command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { inviteCommand } from "../invite";
import chalk from "chalk";

describe("org invite command", () => {
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

  it("should invite member and show success", async () => {
    server.use(
      http.post("http://localhost:3000/api/org/invite", () => {
        return HttpResponse.json({
          message: "Invitation sent to member@example.com",
        });
      }),
    );

    await inviteCommand.parseAsync([
      "node",
      "cli",
      "--email",
      "member@example.com",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("member@example.com");
    expect(logCalls).toContain("Invitation sent");
  });

  it("should handle forbidden error (non-admin)", async () => {
    server.use(
      http.post("http://localhost:3000/api/org/invite", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Only admins can invite members",
              code: "FORBIDDEN",
            },
          },
          { status: 403 },
        );
      }),
    );

    await expect(async () => {
      await inviteCommand.parseAsync([
        "node",
        "cli",
        "--email",
        "member@example.com",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Only admins can invite"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
