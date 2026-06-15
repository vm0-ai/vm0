import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { deleteCommand } from "../delete";
import chalk from "chalk";

describe("zero org delete command", () => {
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

  it("should delete organization with slug confirmation", async () => {
    server.use(
      http.post("http://localhost:3000/api/zero/org/delete", () => {
        return HttpResponse.json({
          message: "Organization deleted",
        });
      }),
    );

    await deleteCommand.parseAsync(["node", "cli", "my-org"]);

    const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
    expect(logCalls).toContain("my-org");
    expect(logCalls).toContain("has been deleted");
  });

  it("should handle forbidden error (non-admin)", async () => {
    server.use(
      http.post("http://localhost:3000/api/zero/org/delete", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Only admins can delete organizations",
              code: "FORBIDDEN",
            },
          },
          { status: 403 },
        );
      }),
    );

    await expect(async () => {
      await deleteCommand.parseAsync(["node", "cli", "my-org"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Only admins can delete"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should handle slug mismatch error", async () => {
    server.use(
      http.post("http://localhost:3000/api/zero/org/delete", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Slug does not match current organization",
              code: "BAD_REQUEST",
            },
          },
          { status: 400 },
        );
      }),
    );

    await expect(async () => {
      await deleteCommand.parseAsync(["node", "cli", "wrong-slug"]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Slug does not match"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
