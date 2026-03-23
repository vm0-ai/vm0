import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { membersCommand } from "../members";
import chalk from "chalk";

describe("zero org members command", () => {
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

  it("should display organization members", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/org/members", () => {
        return HttpResponse.json({
          slug: "my-org",
          role: "admin",
          createdAt: "2024-01-01T00:00:00Z",
          members: [
            { email: "admin@example.com", role: "admin" },
            { email: "member@example.com", role: "member" },
          ],
          pendingInvitations: [],
        });
      }),
    );

    await membersCommand.parseAsync(["node", "cli"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("my-org");
    expect(logCalls).toContain("admin@example.com");
    expect(logCalls).toContain("member@example.com");
  });

  it("should handle forbidden error", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/org/members", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Not authorized to view members",
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
      expect.stringContaining("Not authorized"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
