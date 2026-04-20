import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { removeCommand } from "../remove";
import chalk from "chalk";

describe("zero org remove command", () => {
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
      http.delete("http://localhost:3000/api/zero/org/members", () => {
        return HttpResponse.json({
          message: "Member removed",
        });
      }),
    );

    await removeCommand.parseAsync(["node", "cli", "member@example.com"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("Removed member@example.com from organization");
  });

  it("should handle forbidden error (non-admin)", async () => {
    server.use(
      http.delete("http://localhost:3000/api/zero/org/members", () => {
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
