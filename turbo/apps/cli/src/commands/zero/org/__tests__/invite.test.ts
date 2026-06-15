import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { inviteCommand } from "../invite";
import chalk from "chalk";

describe("zero org invite command", () => {
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

  it("should invite member with default role and show success", async () => {
    server.use(
      http.post("http://localhost:3000/api/zero/org/invite", () => {
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
    expect(logCalls).toContain("as member");
  });

  it("should invite member with --role admin", async () => {
    server.use(
      http.post("http://localhost:3000/api/zero/org/invite", () => {
        return HttpResponse.json({
          message: "Invitation sent to admin@example.com",
        });
      }),
    );

    await inviteCommand.parseAsync([
      "node",
      "cli",
      "--email",
      "admin@example.com",
      "--role",
      "admin",
    ]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("admin@example.com");
    expect(logCalls).toContain("as admin");
  });

  it("should reject invalid role value", async () => {
    await expect(async () => {
      await inviteCommand.parseAsync([
        "node",
        "cli",
        "--email",
        "user@example.com",
        "--role",
        "superadmin",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Invalid role "superadmin"'),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should handle forbidden error (non-admin)", async () => {
    server.use(
      http.post("http://localhost:3000/api/zero/org/invite", () => {
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
