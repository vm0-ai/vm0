import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../../mocks/server";
import { leaveCommand } from "../leave";

describe("zero org leave command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-token");
  });

  it("leaves the current organization without writing local token state", async () => {
    server.use(
      http.post("http://localhost:3000/api/zero/org/leave", () => {
        return HttpResponse.json({ message: "Left organization" });
      }),
    );

    await leaveCommand.parseAsync(["node", "cli"]);

    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Left organization"),
    );
  });

  it("shows the server error when an admin cannot leave", async () => {
    server.use(
      http.post("http://localhost:3000/api/zero/org/leave", () => {
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
