/**
 * Tests for org status command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { membersCommand } from "../members";
import chalk from "chalk";

describe("org status command", () => {
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

  it("should display org name, role, and member list", async () => {
    server.use(
      http.get("http://localhost:3000/api/org/members", () => {
        return HttpResponse.json({
          slug: "my-team",
          role: "admin",
          members: [
            {
              userId: "user-1",
              email: "admin@example.com",
              role: "admin",
              joinedAt: "2025-01-01T00:00:00Z",
            },
            {
              userId: "user-2",
              email: "member@example.com",
              role: "member",
              joinedAt: "2025-01-02T00:00:00Z",
            },
          ],
          createdAt: "2025-01-01T00:00:00Z",
        });
      }),
    );

    await membersCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("my-team");
    expect(logCalls).toContain("admin");
    expect(logCalls).toContain("Members");
    expect(logCalls).toContain("admin@example.com");
    expect(logCalls).toContain("member@example.com");
  });

  it("should show helpful error when no active organization", async () => {
    server.use(
      http.get("http://localhost:3000/api/org/members", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Organization access token required",
              code: "FORBIDDEN",
            },
          },
          { status: 403 },
        );
      }),
    );

    await expect(async () => {
      await membersCommand.parseAsync(["node", "cli"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("No active organization selected"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
